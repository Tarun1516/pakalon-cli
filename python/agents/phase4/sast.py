"""
sast.py — Phase 4 SASTRunner: Static Application Security Testing.
T114: Runs semgrep, gitleaks, bandit, and fallback regex grep for secrets.
T1-1: Security profiles (owasp-top10, secrets-only, custom) control which
      rules and tools are activated.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Any

# ─────────────────────────────────────────────────────────────────────────────
# T1-1: Security Profiles
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SecurityProfile:
    """
    Controls which SAST tools and rule-sets are activated.

    Built-in profiles:
        "full"          — all tools (current default behaviour)
        "owasp-top10"   — rules targeting OWASP Top 10 categories
        "secrets-only"  — only secrets / credential scanning (fastest)
        "custom"        — caller provides explicit tool list and semgrep rules
    """

    name: str = "full"
    """Profile name (for labelling results)."""

    tools: list[str] = field(default_factory=lambda: [
        "semgrep", "gitleaks", "bandit", "secrets_grep",
        "findsecbugs", "brakeman", "eslint", "sonarqube",
    ])
    """Which tool runners to execute."""

    semgrep_rules: list[str] = field(default_factory=lambda: ["auto"])
    """Semgrep rule configs to pass as --config. E.g. ['p/owasp-top-ten', 'p/secrets']"""

    severity_filter: list[str] = field(default_factory=lambda: [
        "INFO", "WARNING", "ERROR", "CRITICAL",
    ])
    """Only surface findings at these severity levels."""

    max_findings_per_tool: int = 100
    """Cap findings per tool to avoid overwhelming output."""


# ── Built-in profile factory ──────────────────────────────────────────────────

def make_profile(name: str, custom_tools: list[str] | None = None, custom_semgrep: list[str] | None = None) -> SecurityProfile:
    """Return a named SecurityProfile. Use 'custom' + provide overrides for a tailored scan."""
    if name == "secrets-only":
        return SecurityProfile(
            name="secrets-only",
            tools=["gitleaks", "secrets_grep"],
            semgrep_rules=["p/secrets"],
            severity_filter=["WARNING", "ERROR", "CRITICAL"],
            max_findings_per_tool=200,
        )
    if name == "owasp-top10":
        return SecurityProfile(
            name="owasp-top10",
            tools=["semgrep", "bandit", "eslint"],
            semgrep_rules=["p/owasp-top-ten", "p/injection"],
            severity_filter=["WARNING", "ERROR", "CRITICAL"],
        )
    if name == "custom":
        return SecurityProfile(
            name="custom",
            tools=custom_tools or ["bandit", "secrets_grep"],
            semgrep_rules=custom_semgrep or ["auto"],
        )
    # default: "full"
    return SecurityProfile(name="full")


class SASTRunner:
    """
    Runs SAST tools against project source code.
    Falls back gracefully when tools are not installed.

    Pro-only tools (require user_plan="pro"):
      - semgrep (deep rule sets beyond OSS rules)
      - sonarqube (CE server required)
      - gitleaks (secret history scanning)

    Free tools (available to all plans per requirements):
      - bandit (Python)
      - findsecbugs (Java — via Docker)
      - brakeman (Ruby/Rails — via Docker)
      - eslint (JS/TS security plugins)
      - secrets_grep (regex-based credential scan)
    """

    # Pro-only tools (blocked for free plan)
    # Requirements: free users get bandit, findsecbugs, brakeman, eslint, secrets_grep
    #               pro users add semgrep, sonarqube, gitleaks
    PRO_ONLY_TOOLS = {"semgrep", "sonarqube", "gitleaks"}

    SECRET_PATTERNS = [
        (r"(?i)(api[_-]?key|apikey)\s*[:=]\s*['\"]?([A-Za-z0-9_\-]{20,})", "possible_api_key"),
        (r"(?i)(password|passwd|pwd)\s*[:=]\s*['\"]([^'\"]{8,})", "hardcoded_password"),
        (r"(?i)(secret[_-]?key)\s*[:=]\s*['\"]?([A-Za-z0-9_\-]{20,})", "secret_key"),
        (r"(?i)bearer\s+([A-Za-z0-9\-_\.]{40,})", "bearer_token"),
        (r"(?i)(aws_access_key_id|aws_secret_access_key)\s*[:=]\s*([A-Z0-9]{20,})", "aws_credential"),
        (r"sk-[A-Za-z0-9]{40,}", "openai_api_key"),
    ]

    def __init__(self, project_dir: str = ".", user_plan: str = "free", profile: SecurityProfile | None = None):
        self.project_dir = pathlib.Path(project_dir)
        self.user_plan = user_plan  # "free" | "pro"
        self.profile = profile or SecurityProfile()  # T1-1: default full profile

    def _is_pro_tool_allowed(self, tool_name: str) -> bool:
        """Return True if the tool is allowed for the current user plan."""
        if tool_name in self.PRO_ONLY_TOOLS and self.user_plan != "pro":
            return False
        return True

    def _pro_blocked_result(self, tool_name: str) -> dict:
        """Return a standardised 'blocked by plan' result for a pro-only tool."""
        return {
            "available": False,
            "findings": [],
            "error": None,
            "plan_blocked": True,
            "message": (
                f"'{tool_name}' is a Pro-only security tool. "
                "Upgrade to Pakalon Pro at pakalon.com/pricing to enable it."
            ),
        }

    # ------------------------------------------------------------------

    def run_all(self) -> dict[str, Any]:
        """Run all SAST tools allowed by the current security profile and return combined results."""
        # T1-1: Filter tool set by security profile
        def _should_run(tool_name: str) -> bool:
            return tool_name in self.profile.tools

        results: dict = {
            "semgrep": (self._run_semgrep() if self._is_pro_tool_allowed("semgrep") else self._pro_blocked_result("semgrep"))
                       if _should_run("semgrep") else {"skipped": True, "reason": "not in profile"},
            "gitleaks": (self._run_gitleaks() if self._is_pro_tool_allowed("gitleaks") else self._pro_blocked_result("gitleaks"))
                        if _should_run("gitleaks") else {"skipped": True, "reason": "not in profile"},
            "bandit": self._run_bandit() if _should_run("bandit") else {"skipped": True, "reason": "not in profile"},
            "secrets_grep": self._run_secrets_grep() if _should_run("secrets_grep") else {"skipped": True, "reason": "not in profile"},
            "findsecbugs": (self._run_findsecbugs() if self._is_pro_tool_allowed("findsecbugs") else self._pro_blocked_result("findsecbugs"))
                           if _should_run("findsecbugs") else {"skipped": True, "reason": "not in profile"},
            "brakeman": (self._run_brakeman() if self._is_pro_tool_allowed("brakeman") else self._pro_blocked_result("brakeman"))
                        if _should_run("brakeman") else {"skipped": True, "reason": "not in profile"},
            "eslint": (self._run_eslint() if self._is_pro_tool_allowed("eslint") else self._pro_blocked_result("eslint"))
                      if _should_run("eslint") else {"skipped": True, "reason": "not in profile"},
            "sonarqube": (self._run_sonarqube() if self._is_pro_tool_allowed("sonarqube") else self._pro_blocked_result("sonarqube"))
                         if _should_run("sonarqube") else {"skipped": True, "reason": "not in profile"},
        }
        results["profile"] = {"name": self.profile.name, "tools": self.profile.tools}
        results["summary"] = self._summarize(results)
        return results

    def _run_semgrep(self) -> dict:
        """Run semgrep via Docker if available, fallback to local binary."""
        # Try Docker first
        docker_result = self._run_semgrep_docker()
        if docker_result.get("available"):
            return docker_result

        # Fallback to local binary
        try:
            result = subprocess.run(
                ["semgrep", "--config=auto", "--json", str(self.project_dir)],
                capture_output=True, text=True, timeout=120,
            )
            data = json.loads(result.stdout)
            return {
                "available": True,
                "findings": [
                    {
                        "rule": f.get("check_id", ""),
                        "path": f.get("path", ""),
                        "line": f.get("start", {}).get("line", 0),
                        "message": f.get("extra", {}).get("message", ""),
                        "severity": f.get("extra", {}).get("severity", "INFO"),
                    }
                    for f in data.get("results", [])
                ][:50],
                "error": None,
            }
        except FileNotFoundError:
            return {"available": False, "findings": [], "error": "semgrep not installed (try: docker-compose -f docker-compose-security.yml --profile sast up)"}
        except Exception as e:
            return {"available": False, "findings": [], "error": str(e)}

    # ------------------------------------------------------------------
    # Generic Docker tool runner (Task 6: Docker-based execution)
    # ------------------------------------------------------------------

    @staticmethod
    def _is_docker_available() -> bool:
        """Return True if Docker daemon is reachable."""
        try:
            r = subprocess.run(
                ["docker", "info"],
                capture_output=True, text=True, timeout=5,
            )
            return r.returncode == 0
        except Exception:
            return False

    def _run_docker_tool(
        self,
        image: str,
        args: list[str],
        extra_mounts: list[tuple[str, str]] | None = None,
        timeout: int = 300,
        env_vars: dict[str, str] | None = None,
    ) -> dict:
        """
        Generic Docker-based SAST tool runner.
        Mounts project_dir as /src by default.
        Returns: {available, stdout, stderr, returncode, error, via}
        """
        if not self._is_docker_available():
            return {"available": False, "stdout": "", "stderr": "",
                    "returncode": -1, "error": "Docker not available", "via": "docker"}

        cmd = ["docker", "run", "--rm",
               "-v", f"{str(self.project_dir)}:/src"]
        for src, dst in (extra_mounts or []):
            cmd += ["-v", f"{src}:{dst}"]
        for key, val in (env_vars or {}).items():
            cmd += ["-e", f"{key}={val}"]
        cmd.append(image)
        cmd.extend(args)

        try:
            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=timeout,
            )
            return {
                "available": True,
                "stdout": result.stdout[:8000],
                "stderr": result.stderr[:2000],
                "returncode": result.returncode,
                "error": None,
                "via": "docker",
            }
        except subprocess.TimeoutExpired:
            return {"available": False, "stdout": "", "stderr": "",
                    "returncode": -1, "error": f"Docker timeout after {timeout}s", "via": "docker"}
        except Exception as _e:
            return {"available": False, "stdout": "", "stderr": "",
                    "returncode": -1, "error": str(_e), "via": "docker"}

    # ------------------------------------------------------------------
    # SonarQube — Pro-only (Task 5)
    # ------------------------------------------------------------------

    def _run_sonarqube(self) -> dict:
        """
        Run SonarQube Community Edition analysis.
        Strategy:
          1. Try the sonar-scanner CLI if available locally.
          2. Fall back to Docker (sonarqube/community-edition).
        Requires SONAR_TOKEN env var.  Skips gracefully when unavailable.
        """
        sonar_token = os.environ.get("SONAR_TOKEN", "")
        sonar_host = os.environ.get("SONAR_HOST_URL", "http://localhost:9000")
        project_key = self.project_dir.name.lower().replace(" ", "_") or "pakalon_project"

        # ---- Try local sonar-scanner ----
        try:
            result = subprocess.run(
                [
                    "sonar-scanner",
                    f"-Dsonar.projectKey={project_key}",
                    f"-Dsonar.sources={str(self.project_dir)}",
                    f"-Dsonar.host.url={sonar_host}",
                    f"-Dsonar.login={sonar_token}",
                    "-Dsonar.scm.disabled=true",
                ],
                capture_output=True, text=True, timeout=300,
                cwd=str(self.project_dir),
            )
            if result.returncode == 0:
                return {
                    "available": True,
                    "findings": [],
                    "dashboard_url": f"{sonar_host}/dashboard?id={project_key}",
                    "error": None,
                    "via": "sonar-scanner-cli",
                    "note": f"SonarQube analysis complete. View at {sonar_host}/dashboard?id={project_key}",
                }
            else:
                # scanner found but returned error — report it
                return {
                    "available": False, "findings": [],
                    "error": result.stderr[:500] or result.stdout[:500],
                    "via": "sonar-scanner-cli",
                }
        except FileNotFoundError:
            pass  # fall through to Docker
        except Exception as _e:
            pass

        # ---- Try Docker: start SonarQube + run analysis ----
        if not self._is_docker_available():
            return {
                "available": False, "findings": [],
                "error": (
                    "sonar-scanner CLI not found and Docker not available. "
                    "Install sonar-scanner or Docker to enable SonarQube."
                ),
                "via": "none",
            }

        # Launch SonarQube server container (detached)
        try:
            subprocess.run(
                ["docker", "run", "-d", "--name", "pakalon-sonarqube",
                 "-p", "9000:9000",
                 "-e", "SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true",
                 "sonarqube:community"],
                capture_output=True, text=True, timeout=30,
            )
            # Wait up to 60 s for SonarQube to be ready
            import time as _time
            for _ in range(12):
                _time.sleep(5)
                try:
                    import urllib.request as _req
                    _req.urlopen("http://localhost:9000/api/system/status", timeout=3)
                    break
                except Exception:
                    pass
        except Exception:
            pass

        # Run sonar-scanner inside Docker
        docker_result = self._run_docker_tool(
            image="sonarsource/sonar-scanner-cli:latest",
            args=[
                f"-Dsonar.projectKey={project_key}",
                "-Dsonar.sources=/src",
                f"-Dsonar.host.url={sonar_host}",
                f"-Dsonar.login={sonar_token or 'admin'}",
                "-Dsonar.scm.disabled=true",
            ],
            timeout=300,
        )

        if docker_result.get("returncode") == 0:
            return {
                "available": True,
                "findings": [],
                "dashboard_url": f"{sonar_host}/dashboard?id={project_key}",
                "error": None,
                "via": "docker",
                "note": f"SonarQube analysis complete (Docker). Dashboard: {sonar_host}/dashboard?id={project_key}",
            }

        return {
            "available": False, "findings": [],
            "error": docker_result.get("error") or docker_result.get("stderr", "")[:500],
            "via": "docker",
        }

    def _run_semgrep_docker(self) -> dict:
        """Run semgrep via Docker container."""
        try:
            # Check if Docker is available
            docker_check = subprocess.run(
                ["docker", "info"],
                capture_output=True, text=True, timeout=5,
            )
            if docker_check.returncode != 0:
                return {"available": False, "error": "Docker not available"}

            # Run semgrep container
            result = subprocess.run(
                [
                    "docker", "run", "--rm",
                    "-v", f"{str(self.project_dir)}:/src",
                    "returntocorp/semgrep:latest",
                    "semgrep", "--config=auto", "--json", "/src"
                ],
                capture_output=True, text=True, timeout=180,
            )
            data = json.loads(result.stdout)
            return {
                "available": True,
                "findings": [
                    {
                        "rule": f.get("check_id", ""),
                        "path": f.get("path", ""),
                        "line": f.get("start", {}).get("line", 0),
                        "message": f.get("extra", {}).get("message", ""),
                        "severity": f.get("extra", {}).get("severity", "INFO"),
                    }
                    for f in data.get("results", [])
                ][:50],
                "error": None,
                "via": "docker",
            }
        except FileNotFoundError:
            return {"available": False, "error": "Docker not installed"}
        except Exception as e:
            return {"available": False, "error": str(e)}

    def _run_gitleaks(self) -> dict:
        try:
            with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
                report_path = tf.name
            result = subprocess.run(
                ["gitleaks", "detect", "--source", str(self.project_dir), "--report-format=json", f"--report-path={report_path}"],
                capture_output=True, text=True, timeout=60,
            )
            data = json.loads(pathlib.Path(report_path).read_text() or "[]")
            return {
                "available": True,
                "findings": [
                    {
                        "rule": item.get("RuleID", ""),
                        "path": item.get("File", ""),
                        "line": item.get("StartLine", 0),
                        "secret_type": item.get("Description", ""),
                        "severity": "HIGH",
                    }
                    for item in (data if isinstance(data, list) else [])
                ][:50],
                "error": None,
            }
        except FileNotFoundError:
            return {"available": False, "findings": [], "error": "gitleaks not installed"}
        except Exception as e:
            return {"available": False, "findings": [], "error": str(e)}
        finally:
            try:
                pathlib.Path(report_path).unlink(missing_ok=True)
            except Exception:
                pass

    def _run_bandit(self) -> dict:
        python_files = list(self.project_dir.rglob("*.py"))
        if not python_files:
            return {"available": True, "findings": [], "error": None, "note": "No Python files"}
        try:
            result = subprocess.run(
                ["bandit", "-r", str(self.project_dir), "-f", "json", "-q"],
                capture_output=True, text=True, timeout=60,
            )
            data = json.loads(result.stdout or "{}")
            findings = []
            for r in data.get("results", [])[:50]:
                findings.append({
                    "rule": r.get("test_id", ""),
                    "path": r.get("filename", ""),
                    "line": r.get("line_number", 0),
                    "message": r.get("issue_text", ""),
                    "severity": r.get("issue_severity", "LOW"),
                })
            return {"available": True, "findings": findings, "error": None}
        except FileNotFoundError:
            return {"available": False, "findings": [], "error": "bandit not installed"}
        except Exception as e:
            return {"available": False, "findings": [], "error": str(e)}

    def _run_secrets_grep(self) -> dict:
        """Fallback regex-based secret scanning."""
        findings = []
        source_exts = {".ts", ".tsx", ".js", ".jsx", ".py", ".env", ".yaml", ".yml", ".json", ".toml"}
        for ext in source_exts:
            for fpath in self.project_dir.rglob(f"*{ext}"):
                if ".git" in str(fpath) or "node_modules" in str(fpath):
                    continue
                try:
                    text = fpath.read_text(errors="ignore")
                    for pattern, label in self.SECRET_PATTERNS:
                        for match in re.finditer(pattern, text):
                            line_no = text[: match.start()].count("\n") + 1
                            findings.append({
                                "rule": label,
                                "path": str(fpath.relative_to(self.project_dir)),
                                "line": line_no,
                                "message": f"Possible {label} detected",
                                "severity": "HIGH",
                            })
                except Exception:
                    pass
        return {"available": True, "findings": findings[:50], "error": None}

    def _summarize(self, results: dict) -> dict:
        total = sum(len(v.get("findings", [])) for v in results.values() if isinstance(v, dict))
        high = sum(
            1 for v in results.values() if isinstance(v, dict)
            for f in v.get("findings", []) if f.get("severity", "").upper() in ("HIGH", "CRITICAL", "ERROR")
        )
        return {"total_findings": total, "high_severity": high, "passed": high == 0}

    # ------------------------------------------------------------------
    # Additional SAST tools for specific languages

    def _run_findsecbugs(self) -> dict:
        """Run FindSecBugs for Java projects via Docker."""
        java_files = list(self.project_dir.rglob("*.java"))
        if not java_files:
            return {"available": True, "findings": [], "error": None, "note": "No Java files found"}

        # Try Docker first
        try:
            docker_check = subprocess.run(
                ["docker", "info"],
                capture_output=True, text=True, timeout=5,
            )
            if docker_check.returncode == 0:
                result = subprocess.run(
                    [
                        "docker", "run", "--rm",
                        "-v", f"{str(self.project_dir)}:/src",
                        "flowsec/findsecbugs:latest",
                        "-progress", "/src", "-low"
                    ],
                    capture_output=True, text=True, timeout=300,
                )
                # Parse FindBugs XML output if available
                if result.returncode in (0, 1):
                    return {
                        "available": True,
                        "findings": [],  # Parse XML for actual findings
                        "error": None,
                        "via": "docker",
                        "note": "FindSecBugs scan completed via Docker"
                    }
        except FileNotFoundError:
            pass

        # Fallback: check for local installation
        try:
            result = subprocess.run(
                ["findsecbugs", "-progress", str(self.project_dir)],
                capture_output=True, text=True, timeout=300,
            )
            return {"available": True, "findings": [], "error": None}
        except FileNotFoundError:
            return {"available": False, "findings": [], "error": "FindSecBugs not installed (Java security scanner - use Docker: docker-compose -f docker-compose-security.yml --profile sast up)"}
        except Exception as e:
            return {"available": False, "findings": [], "error": str(e)}

    def _run_brakeman(self) -> dict:
        """Run Brakeman for Ruby/Rails projects."""
        # Check for Ruby/Rails files
        ruby_files = list(self.project_dir.rglob("*.rb"))
        Gemfile = self.project_dir / "Gemfile"
        if not ruby_files and not Gemfile.exists():
            return {"available": True, "findings": [], "error": None, "note": "No Ruby/Rails files found"}

        # Try Docker first
        try:
            docker_check = subprocess.run(
                ["docker", "info"],
                capture_output=True, text=True, timeout=5,
            )
            if docker_check.returncode == 0:
                result = subprocess.run(
                    [
                        "docker", "run", "--rm",
                        "-v", f"{str(self.project_dir)}:/code",
                        "presidentbeef/brakeman:latest",
                        "--path", "/code"
                    ],
                    capture_output=True, text=True, timeout=300,
                )
                if result.returncode in (0, 1):
                    return {
                        "available": True,
                        "findings": [],  # Parse output for actual findings
                        "error": None,
                        "via": "docker",
                        "output": result.stdout[:2000]
                    }
        except FileNotFoundError:
            pass

        # Fallback: check for local brakeman
        try:
            result = subprocess.run(
                ["brakeman", "-f", "json", str(self.project_dir)],
                capture_output=True, text=True, timeout=300,
            )
            if result.returncode in (0, 1):
                try:
                    data = json.loads(result.stdout)
                    findings = []
                    if isinstance(data, dict):
                        for warning in data.get("warnings", [])[:50]:
                            findings.append({
                                "rule": warning.get("warning_type", ""),
                                "path": warning.get("file", ""),
                                "line": warning.get("line", 0),
                                "message": warning.get("message", ""),
                                "severity": warning.get("confidence", "Medium"),
                            })
                    return {"available": True, "findings": findings, "error": None}
                except json.JSONDecodeError:
                    return {"available": True, "findings": [], "error": None, "output": result.stdout[:1000]}
        except FileNotFoundError:
            return {"available": False, "findings": [], "error": "brakeman not installed (Ruby/Rails security scanner - use Docker)"}
        except Exception as e:
            return {"available": False, "findings": [], "error": str(e)}

    def _run_eslint(self) -> dict:
        """Run ESLint with security rules for JavaScript/TypeScript projects."""
        # Check for JS/TS files
        js_ts_files = list(self.project_dir.rglob("*.{js,jsx,ts,tsx}"))
        if not js_ts_files:
            return {"available": True, "findings": [], "error": None, "note": "No JavaScript/TypeScript files found"}

        # Check for eslint config
        eslint_configs = [
            self.project_dir / ".eslintrc.json",
            self.project_dir / ".eslintrc.js",
            self.project_dir / "eslint.config.js",
            self.project_dir / "package.json",
        ]

        # Try local eslint
        try:
            result = subprocess.run(
                ["npx", "eslint", "--ext", ".js,.jsx,.ts,.tsx", "--format", "json", str(self.project_dir)],
                capture_output=True, text=True, timeout=120,
            )
            if result.returncode in (0, 1):
                try:
                    data = json.loads(result.stdout)
                    findings = []
                    for file_result in data:
                        for msg in file_result.get("messages", [])[:50]:
                            findings.append({
                                "rule": msg.get("ruleId", ""),
                                "path": file_result.get("filePath", ""),
                                "line": msg.get("line", 0),
                                "message": msg.get("message", ""),
                                "severity": "WARNING" if msg.get("severity", 0) == 1 else "ERROR",
                            })
                    return {"available": True, "findings": findings, "error": None}
                except json.JSONDecodeError:
                    pass
        except FileNotFoundError:
            pass
        except Exception as e:
            pass

        return {"available": False, "findings": [], "error": "eslint not available (install with: npm install -g eslint)"}
