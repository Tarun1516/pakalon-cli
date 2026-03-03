"""
dast.py — Phase 4 DASTRunner: Dynamic Application Security Testing.
T115: Runs ZAP baseline, nikto, sqlmap, nmap port scan, httpx security headers check.
W: Security report normalization — OWASP Top 10, CWE mapping, severity standardization.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import tempfile
from typing import Any

try:
    import httpx as _httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False


# ---------------------------------------------------------------------------
# W: OWASP Top 10 + CWE normalization tables
# ---------------------------------------------------------------------------

# Maps common finding patterns → OWASP Top 10 (2021) category + CWE IDs
_OWASP_RULES: list[tuple[re.Pattern, str, str, list[int]]] = [
    # (pattern on name/description, OWASP 2021 ID, OWASP name, CWE IDs)
    (re.compile(r"sql\s*inject|sqli", re.I),          "A03:2021", "Injection",                                        [89]),
    (re.compile(r"xss|cross.site.script",    re.I),    "A03:2021", "Injection",                                        [79]),
    (re.compile(r"command.inject|os.inject", re.I),    "A03:2021", "Injection",                                        [78]),
    (re.compile(r"broken.auth|credential|session.fix", re.I), "A07:2021", "Identification and Authentication Failures", [287, 306]),
    (re.compile(r"csrf|cross.site.request",  re.I),    "A01:2021", "Broken Access Control",                            [352]),
    (re.compile(r"path.travers|directory.trav|lfi|rfi", re.I), "A01:2021", "Broken Access Control",                   [22]),
    (re.compile(r"ssrf|server.side.request", re.I),    "A10:2021", "Server-Side Request Forgery",                      [918]),
    (re.compile(r"idor|insecure.direct|broken.access|missing.auth", re.I), "A01:2021", "Broken Access Control",        [285, 639]),
    (re.compile(r"secret|api.key|hardcod|exposed.cred", re.I), "A02:2021", "Cryptographic Failures",                   [798, 321]),
    (re.compile(r"weak.crypto|md5|sha1|des\b|rc4",     re.I),    "A02:2021", "Cryptographic Failures",                 [327]),
    (re.compile(r"outdated|vulnerable.component|known.vuln", re.I), "A06:2021", "Vulnerable and Outdated Components", [1104]),
    (re.compile(r"xxe|xml.external",         re.I),    "A05:2021", "Security Misconfiguration",                        [611]),
    (re.compile(r"security.misconfigur|default.config|error.message|stack.trace", re.I), "A05:2021", "Security Misconfiguration", [16]),
    (re.compile(r"insecure.design|missing.rate|business.logic", re.I), "A04:2021", "Insecure Design",                  [840]),
    (re.compile(r"log.inject|logging.fail|audit",      re.I),    "A09:2021", "Security Logging and Monitoring Failures", [778]),
    (re.compile(r"open.redirect|unvalidated.redirect",  re.I),   "A01:2021", "Broken Access Control",                  [601]),
    (re.compile(r"hsts|strict.transport",              re.I),    "A05:2021", "Security Misconfiguration",               [319]),
    (re.compile(r"content.security.policy|csp\b",      re.I),    "A05:2021", "Security Misconfiguration",               [693]),
    (re.compile(r"clickjack|x.frame",                  re.I),    "A05:2021", "Security Misconfiguration",               [1021]),
    (re.compile(r"deseri",                             re.I),    "A08:2021", "Software and Data Integrity Failures",    [502]),
]

# Severity normalization: maps tool-specific labels → canonical levels
_SEVERITY_MAP: dict[str, str] = {
    # ZAP risk levels
    "high":          "HIGH",
    "medium":        "MEDIUM",
    "low":           "LOW",
    "informational": "INFO",
    "info":          "INFO",
    # Nikto / generic
    "critical":      "CRITICAL",
    "warning":       "MEDIUM",
    "warn":          "MEDIUM",
    "notice":        "LOW",
    "note":          "INFO",
    "debug":         "INFO",
    # Numeric (CVSS-style)
    "0": "INFO", "1": "INFO", "2": "LOW", "3": "LOW",
    "4": "MEDIUM", "5": "MEDIUM", "6": "MEDIUM",
    "7": "HIGH", "8": "HIGH", "9": "CRITICAL", "10": "CRITICAL",
}

CANONICAL_SEVERITIES = {"CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"}


def normalize_severity(raw: str) -> str:
    """Convert any tool-specific severity string to CRITICAL/HIGH/MEDIUM/LOW/INFO."""
    if not raw:
        return "INFO"
    key = raw.strip().lower().split()[0]  # take first word ("High (3)" → "high")
    return _SEVERITY_MAP.get(key, "LOW" if key not in ("", "none") else "INFO")


def enrich_finding(finding: dict) -> dict:
    """
    Add OWASP Top 10 category and CWE ID(s) to a finding dict in-place.

    Looks at 'name', 'description', 'message' fields.
    Sets:
      - finding["owasp_category"] = "A03:2021"
      - finding["owasp_name"]     = "Injection"
      - finding["cwe_ids"]        = [89]
      - finding["severity"]       = normalized canonical severity
    Returns the mutated finding.
    """
    # Normalize severity first
    raw_sev = finding.get("severity") or finding.get("risk") or ""
    finding["severity"] = normalize_severity(raw_sev)

    # Text corpus for OWASP matching
    corpus = " ".join(filter(None, [
        finding.get("name", ""),
        finding.get("description", ""),
        finding.get("message", ""),
        finding.get("alert", ""),
        finding.get("type", ""),
    ]))

    for pattern, owasp_id, owasp_name, cwe_ids in _OWASP_RULES:
        if pattern.search(corpus):
            finding.setdefault("owasp_category", owasp_id)
            finding.setdefault("owasp_name", owasp_name)
            finding.setdefault("cwe_ids", cwe_ids)
            break
    else:
        finding.setdefault("owasp_category", "UNKNOWN")
        finding.setdefault("owasp_name", "Uncategorized")
        finding.setdefault("cwe_ids", [])

    return finding



class DASTRunner:
    """
    Runs DAST tools against a running web application.
    All tools fall back gracefully when not installed.

    Pro-only tools (require user_plan="pro"):
      - OWASP ZAP baseline scan
      - Nikto web vulnerability scanner

    Free tools (available to all plans per requirements):
      - sqlmap (SQL injection scanner)
      - wapiti (web application vulnerability scanner)
      - xsstrike (XSS scanner)
      - Security headers check (HTTP GET)
      - Nmap port scan
    """

    # Pro-only tools — requirements: ZAP + Nikto are pro; sqlmap/wapiti/xsstrike are free
    PRO_ONLY_TOOLS = {"zap", "nikto"}

    SECURITY_HEADERS = [
        "Strict-Transport-Security",
        "Content-Security-Policy",
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Permissions-Policy",
    ]

    def __init__(self, target_url: str = "", project_dir: str = ".", user_plan: str = "free"):
        self.project_dir = pathlib.Path(project_dir)
        self.user_plan = user_plan  # "free" | "pro"
        # Auto-discover target URL when not supplied
        if target_url:
            self.target_url = target_url.rstrip("/")
        else:
            self.target_url = DASTRunner.discover_target_url(project_dir)

    def _is_pro_tool_allowed(self, tool_name: str) -> bool:
        return not (tool_name in self.PRO_ONLY_TOOLS and self.user_plan != "pro")

    def _pro_blocked_result(self, tool_name: str) -> dict:
        return {
            "available": False,
            "alerts": [],
            "findings": [],
            "error": None,
            "plan_blocked": True,
            "message": (
                f"'{tool_name}' is a Pro-only security tool. "
                "Upgrade to Pakalon Pro at pakalon.com/pricing to enable it."
            ),
        }

    # ------------------------------------------------------------------
    # Auto-discovery of the application target URL
    # ------------------------------------------------------------------

    @staticmethod
    def discover_target_url(project_dir: str = ".") -> str:
        """
        Heuristically determine the dev-server URL for the project.

        Probe order (first match wins):
        1. DAST_TARGET_URL environment variable
        2. pakalon.config.json / .pakalon/config.json  → dastTargetUrl
        3. .env / .env.local  → PORT, APP_PORT, VITE_PORT, NEXT_PUBLIC_PORT
        4. vite.config.ts / vite.config.js  → server.port
        5. package.json scripts  → port flag in dev/start/preview scripts
        6. docker-compose.yml   → first published port
        7. Default fallback     → http://localhost:3000
        """
        root = pathlib.Path(project_dir).resolve()
        DEFAULT = "http://localhost:3000"

        # 1. Env var override
        env_override = os.environ.get("DAST_TARGET_URL", "").strip()
        if env_override:
            return env_override.rstrip("/")

        # 2. pakalon.config.json
        for cfg_name in (".pakalon/config.json", ".pakalon/config.jsonc", "pakalon.config.json"):
            cfg_path = root / cfg_name
            if cfg_path.exists():
                try:
                    raw = cfg_path.read_text(encoding="utf-8")
                    # Strip JS-style comments (JSONC)
                    raw = re.sub(r"//[^\n]*", "", raw)
                    raw = re.sub(r"/\*.*?\*/", "", raw, flags=re.DOTALL)
                    cfg = json.loads(raw)
                    url = cfg.get("dastTargetUrl", "")
                    if url:
                        return url.rstrip("/")
                except Exception:
                    pass

        def _port_to_url(port: int | str) -> str:
            return f"http://localhost:{port}"

        # 3. .env / .env.local port variables
        for env_file in (".env.local", ".env"):
            env_path = root / env_file
            if env_path.exists():
                try:
                    for line in env_path.read_text(encoding="utf-8").splitlines():
                        line = line.strip()
                        if line.startswith("#") or "=" not in line:
                            continue
                        key, _, val = line.partition("=")
                        key = key.strip()
                        val = val.strip().strip('"').strip("'")
                        if key in ("PORT", "APP_PORT", "VITE_PORT", "NEXT_PUBLIC_PORT", "SERVER_PORT"):
                            if val.isdigit():
                                return _port_to_url(int(val))
                except Exception:
                    pass

        # 4. vite.config.{ts,js,mts,mjs}
        for vite_cfg in ("vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"):
            vite_path = root / vite_cfg
            if vite_path.exists():
                try:
                    text = vite_path.read_text(encoding="utf-8")
                    m = re.search(r"server\s*[:\{][^}]*port\s*:\s*(\d+)", text)
                    if m:
                        return _port_to_url(int(m.group(1)))
                    # Also handle defineConfig({ server: { port: 5173 } }) flat match
                    m2 = re.search(r"port\s*:\s*(\d{4,5})", text)
                    if m2:
                        return _port_to_url(int(m2.group(1)))
                except Exception:
                    pass

        # 5. package.json scripts — look for --port flag or PORT= prefix
        pkg_path = root / "package.json"
        if pkg_path.exists():
            try:
                pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
                scripts = pkg.get("scripts", {})
                for script_key in ("dev", "start", "preview", "serve"):
                    script_val = scripts.get(script_key, "")
                    # --port 8080 or --port=8080
                    m = re.search(r"--port[=\s]+(\d{4,5})", script_val)
                    if m:
                        return _port_to_url(int(m.group(1)))
                    # PORT=8080 prefix
                    m2 = re.search(r"\bPORT=(\d{4,5})\b", script_val)
                    if m2:
                        return _port_to_url(int(m2.group(1)))
                    # -p 8080 (some CLIs)
                    m3 = re.search(r"\s-p\s+(\d{4,5})\b", script_val)
                    if m3:
                        return _port_to_url(int(m3.group(1)))
            except Exception:
                pass

        # 6. docker-compose.yml — first port mapping under services
        for dc_file in ("docker-compose.yml", "docker-compose.yaml"):
            dc_path = root / dc_file
            if dc_path.exists():
                try:
                    text = dc_path.read_text(encoding="utf-8")
                    # Match  "- '8080:80'"  or  "- 3000:3000"
                    m = re.search(r"-\s+['\"]?(\d{3,5}):\d+['\"]?", text)
                    if m:
                        return _port_to_url(int(m.group(1)))
                except Exception:
                    pass

        return DEFAULT

    # ------------------------------------------------------------------

    def _ensure_dast_tools(self) -> None:
        """
        T115-DOCKER: Auto-pull any missing Docker images needed for DAST scanning.

        Called once at the top of run_all(). Pulls images in background threads
        so the scan can proceed in parallel. Failures are soft — if a pull fails
        the scan simply reports the tool as unavailable.

        Images pulled:
          - ghcr.io/zaproxy/zaproxy:stable        (Pro plan only)
          - securecodebox/nikto:latest              (Pro plan only)
          - returntocorp/semgrep:latest             (free)
          - sqlmapproject/sqlmap:latest             (free)
        """
        if not self._is_docker_available():
            return

        # Determine which images we need
        images: list[str] = [
            "returntocorp/semgrep:latest",
            "sqlmapproject/sqlmap:latest",
        ]
        if self.user_plan == "pro":
            images += [
                "ghcr.io/zaproxy/zaproxy:stable",
                "securecodebox/nikto:latest",
            ]

        import threading
        pull_errors: dict[str, str] = {}

        def _pull(image: str) -> None:
            try:
                result = subprocess.run(
                    ["docker", "image", "inspect", image],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    return  # already present
                pull_result = subprocess.run(
                    ["docker", "pull", image],
                    capture_output=True, text=True, timeout=300
                )
                if pull_result.returncode != 0:
                    pull_errors[image] = pull_result.stderr.strip()
            except Exception as exc:
                pull_errors[image] = str(exc)

        threads = [threading.Thread(target=_pull, args=(img,), daemon=True) for img in images]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=310)  # max 5 min per image, run in parallel

        if pull_errors:
            import sys
            print(
                f"[DAST] Warning: could not pull some images: "
                + ", ".join(f"{img}: {err}" for img, err in pull_errors.items()),
                file=sys.stderr,
            )

    # ------------------------------------------------------------------

    def run_all(self) -> dict[str, Any]:
        """Run all DAST checks and return combined results."""
        # T115-DOCKER: Auto-provision required Docker images before scanning
        self._ensure_dast_tools()
        results: dict = {
            "security_headers": self._check_security_headers(),
            "zap": self._run_zap() if self._is_pro_tool_allowed("zap") else self._pro_blocked_result("zap"),
            "nikto": self._run_nikto() if self._is_pro_tool_allowed("nikto") else self._pro_blocked_result("nikto"),
            "nmap": self._run_nmap(),
            "sqlmap": self._run_sqlmap(),
            "wapiti": self._run_wapiti(),
            "xsstrike": self._run_xsstrike(),
        }
        results["summary"] = self._summarize(results)
        return results

    # ------------------------------------------------------------------
    # Generic Docker runner (Task 6: Docker-based tool execution)
    # ------------------------------------------------------------------

    @staticmethod
    def _is_docker_available() -> bool:
        try:
            r = subprocess.run(["docker", "info"], capture_output=True, text=True, timeout=5)
            return r.returncode == 0
        except Exception:
            return False

    def _run_docker_tool(
        self,
        image: str,
        args: list[str],
        extra_mounts: list[tuple[str, str]] | None = None,
        env_vars: dict[str, str] | None = None,
        network: str = "host",
        timeout: int = 300,
    ) -> dict:
        """
        Generic Docker-based DAST tool runner.
        Returns: {available, stdout, stderr, returncode, error, via}
        """
        if not self._is_docker_available():
            return {"available": False, "stdout": "", "stderr": "",
                    "returncode": -1, "error": "Docker not available", "via": "docker"}

        cmd = ["docker", "run", "--rm", "--network", network]
        for src, dst in (extra_mounts or []):
            cmd += ["-v", f"{src}:{dst}"]
        for key, val in (env_vars or {}).items():
            cmd += ["-e", f"{key}={val}"]
        cmd.append(image)
        cmd.extend(args)

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
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
                    "returncode": -1, "error": f"Timeout after {timeout}s", "via": "docker"}
        except Exception as _e:
            return {"available": False, "stdout": "", "stderr": "",
                    "returncode": -1, "error": str(_e), "via": "docker"}

    # ------------------------------------------------------------------

    def _check_security_headers(self) -> dict:
        """Check for missing security headers via HTTP GET — enriched with OWASP/CWE."""
        if not HTTPX_AVAILABLE:
            return {"available": False, "missing": [], "present": [], "findings": [], "error": "httpx not installed"}
        try:
            resp = _httpx.get(self.target_url, timeout=10, follow_redirects=True)
            missing = []
            present = []
            findings = []
            for header in self.SECURITY_HEADERS:
                if header.lower() in {k.lower() for k in resp.headers.keys()}:
                    present.append(header)
                else:
                    missing.append(header)
                    # Create a normalized finding for each missing header
                    finding = {
                        "name": f"Missing security header: {header}",
                        "description": f"The HTTP response is missing the {header} header.",
                        "severity": "MEDIUM" if header in (
                            "Strict-Transport-Security", "Content-Security-Policy"
                        ) else "LOW",
                        "source": "headers",
                        "url": self.target_url,
                    }
                    findings.append(enrich_finding(finding))
            return {
                "available": True,
                "missing": missing,
                "present": present,
                "findings": findings,
                "status_code": resp.status_code,
                "error": None,
            }
        except Exception as e:
            return {"available": False, "missing": [], "present": [], "findings": [], "error": str(e)}

    def _run_zap(self) -> dict:
        """
        Run OWASP ZAP scan.

        Scan mode:
          - Free / baseline: zap-baseline.py  (passive spider + passive rules only)
          - Pro / full-scan: zap-full-scan.py  (active spider + active attack rules)
                            Supports session context injection for authenticated scanning.

        Attempt order: native CLI → Docker image ghcr.io/zaproxy/zaproxy:stable
        """
        # Pro plan uses the full active scan; free gets baseline (passive only)
        is_full_scan = (self.user_plan == "pro")
        scan_script = "zap-full-scan.py" if is_full_scan else "zap-baseline.py"

        # Auth context: if DAST_ZAP_SESSION_TOKEN is set inject it as a bearer header
        zap_session_token = os.environ.get("DAST_ZAP_SESSION_TOKEN", "")
        extra_native_args: list[str] = []
        extra_docker_args: list[str] = []
        if zap_session_token:
            header_arg = f"Authorization: Bearer {zap_session_token}"
            extra_native_args = ["-H", header_arg]
            extra_docker_args = ["-H", header_arg]

        host_dir = tempfile.mkdtemp()
        report_file = pathlib.Path(host_dir) / "zap_report.json"

        # --- Attempt 1: native ZAP CLI ---
        try:
            native_cmd = (
                [scan_script, "-t", self.target_url, "-J", str(report_file), "-I"]
                + extra_native_args
            )
            subprocess.run(native_cmd, capture_output=True, text=True, timeout=600)
            if report_file.exists():
                data = json.loads(report_file.read_text())
                alerts = self._parse_zap_json(data)
                return {
                    "available": True, "alerts": alerts, "error": None,
                    "source": "native", "scan_type": "full" if is_full_scan else "baseline",
                }
        except FileNotFoundError:
            pass  # native ZAP not installed — try Docker
        except Exception as e:
            return {"available": False, "alerts": [], "error": str(e)}

        # --- Attempt 2: Docker ZAP ---
        try:
            result = subprocess.run(["docker", "info"], capture_output=True, timeout=5)
            if result.returncode != 0:
                return {"available": False, "alerts": [], "error": "Docker not available", "source": "docker"}

            timeout_s = 600 if is_full_scan else 300
            cmd = [
                "docker", "run", "--rm",
                "--network", "host",
                "-v", f"{host_dir}:/zap/wrk:rw",
                "ghcr.io/zaproxy/zaproxy:stable",
                scan_script,
                "-t", self.target_url,
                "-J", "zap_report.json",
                "-I",
            ] + extra_docker_args

            # For full scans also pass -m (max-depth) and -T (timeout minutes)
            if is_full_scan:
                cmd += ["-m", "5", "-T", "8"]  # max 5 mins spider, 8 min total

            subprocess.run(cmd, capture_output=True, timeout=timeout_s)
            if report_file.exists():
                data = json.loads(report_file.read_text())
                alerts = self._parse_zap_json(data)
                return {
                    "available": True, "alerts": alerts, "error": None,
                    "source": "docker", "scan_type": "full" if is_full_scan else "baseline",
                }
            return {"available": False, "alerts": [], "error": "ZAP Docker ran but produced no report", "source": "docker"}
        except FileNotFoundError:
            return {"available": False, "alerts": [], "error": "Docker not installed", "source": "docker"}
        except Exception as e:
            return {"available": False, "alerts": [], "error": str(e), "source": "docker"}

    def _parse_zap_json(self, data: dict) -> list[dict]:
        """
        Extract and normalize the full alert list from a ZAP JSON report.

        Handles both zap-baseline and zap-full-scan output formats.
        Extracts up to 50 alerts; enriches each with OWASP/CWE mapping.
        """
        alerts: list[dict] = []
        sites = data.get("site", [])
        if isinstance(sites, dict):
            sites = [sites]  # single-site reports are sometimes a bare dict

        for site in sites:
            for alert in site.get("alerts", [])[:50]:
                # Extract URLs from alert instances
                instances = alert.get("instances", {}).get("instance", [])
                if isinstance(instances, dict):
                    instances = [instances]
                affected_urls = [
                    inst.get("uri", self.target_url) for inst in instances
                    if isinstance(inst, dict)
                ] or [self.target_url]

                # Extract solution/reference text
                solution = alert.get("solution", "")
                reference = alert.get("reference", "")
                cwe_id_raw = alert.get("cweid", "")
                wasc_id_raw = alert.get("wascid", "")

                finding: dict = {
                    "name": alert.get("name", alert.get("alert", "")),
                    "risk": alert.get("riskdesc", ""),
                    "confidence": alert.get("confidence", alert.get("confidencedesc", "")),
                    "url": affected_urls[0],
                    "affected_urls": affected_urls[:10],
                    "description": (alert.get("desc", "") or "")[:500],
                    "solution": (solution or "")[:300],
                    "reference": (reference or "")[:200] if reference else "",
                    "severity": (alert.get("riskdesc", "") or "").split(" ")[0].upper() or "INFO",
                    "source": "zap",
                    "plugin_id": alert.get("pluginid", ""),
                    "wasc_id": wasc_id_raw,
                }
                # Inject CWE from ZAP report if present (overrides OWASP-rule mapping)
                if cwe_id_raw and str(cwe_id_raw).isdigit():
                    finding["cwe_ids"] = [int(cwe_id_raw)]
                alerts.append(enrich_finding(finding))
        return alerts

    def _run_nikto(self) -> dict:
        """Run Nikto web scanner — native first, Docker fallback. Findings enriched with OWASP/CWE."""
        import urllib.parse
        parsed = urllib.parse.urlparse(self.target_url)
        host = parsed.hostname or "localhost"
        port = str(parsed.port or (443 if parsed.scheme == "https" else 80))

        def _enrich_nikto_findings(raw_findings: list) -> list[dict]:
            enriched = []
            for f in raw_findings[:30]:
                msg = str(f.get("message", f) if isinstance(f, dict) else f)
                finding = {
                    "message": msg,
                    "name": msg[:100],
                    "description": msg,
                    "severity": "MEDIUM",
                    "source": "nikto",
                }
                enriched.append(enrich_finding(finding))
            return enriched

        # --- Attempt 1: native nikto ---
        try:
            result = subprocess.run(
                ["nikto", "-h", host, "-p", port, "-Format", "json", "-output", "/dev/stdout"],
                capture_output=True, text=True, timeout=120,
            )
            raw: list = []
            for line in result.stdout.splitlines():
                if "OSVDB" in line or "found" in line.lower():
                    raw.append({"message": line.strip()})
            return {"available": True, "findings": _enrich_nikto_findings(raw), "error": None, "via": "native"}
        except FileNotFoundError:
            pass  # not installed — try Docker
        except Exception as e:
            return {"available": False, "findings": [], "error": str(e)}

        # --- Attempt 2: Docker Nikto ---
        host_result_dir = tempfile.mkdtemp()
        docker_result = self._run_docker_tool(
            image="frapsoft/nikto:latest",
            args=["-h", self.target_url, "-Format", "json", "-output", "/results/nikto.json"],
            extra_mounts=[(host_result_dir, "/results")],
            network="host",
            timeout=180,
        )
        nikto_report = pathlib.Path(host_result_dir) / "nikto.json"
        if nikto_report.exists():
            try:
                data = json.loads(nikto_report.read_text())
                findings_raw = data.get("vulnerabilities", data.get("findings", []))
                return {
                    "available": True,
                    "findings": _enrich_nikto_findings(findings_raw),
                    "error": None,
                    "via": "docker",
                }
            except Exception:
                pass
        if docker_result.get("available"):
            lines = (docker_result["stdout"] or "").splitlines()
            raw = [{"message": l.strip()} for l in lines if "OSVDB" in l or "found" in l.lower()]
            return {"available": True, "findings": _enrich_nikto_findings(raw), "error": None, "via": "docker"}

        return {
            "available": False, "findings": [],
            "error": docker_result.get("error") or "nikto not installed and Docker runner failed",
        }

    def _run_nmap(self) -> dict:
        """Run Nmap port scan on service host."""
        try:
            import urllib.parse
            parsed = urllib.parse.urlparse(self.target_url)
            host = parsed.hostname or "localhost"
            result = subprocess.run(
                ["nmap", "-sV", "--open", "-oJ", "-", host],
                capture_output=True, text=True, timeout=60,
            )
            data = json.loads(result.stdout or "{}")
            open_ports = []
            for host_data in data.get("nmaprun", {}).get("host", []):
                for port in host_data.get("ports", {}).get("port", []):
                    if isinstance(port, dict) and port.get("state", {}).get("state") == "open":
                        open_ports.append({
                            "port": port.get("portid"),
                            "protocol": port.get("protocol"),
                            "service": port.get("service", {}).get("name"),
                        })
            return {"available": True, "open_ports": open_ports, "error": None}
        except FileNotFoundError:
            return {"available": False, "open_ports": [], "error": "nmap not installed"}
        except Exception as e:
            return {"available": False, "open_ports": [], "error": str(e)}

    def _run_sqlmap(self) -> dict:
        """
        Run SQLMap for SQL injection testing.

        Enhancements over the basic invocation:
        - `--forms`   : auto-discover and test HTML forms (crawl-first injection discovery)
        - `--crawl=2` : crawl 2 levels deep to find injection parameters
        - `--batch`   : fully automated (no user interaction)
        - `--risk=2 --level=3` : sensible defaults (not too aggressive)
        - `--output-dir`: structured result files for post-scan parsing

        Result files are parsed to extract confirmed SQL injection findings.
        """
        output_dir = self.project_dir / ".pakalon" / "sqlmap-results"
        output_dir.mkdir(parents=True, exist_ok=True)

        base_args = [
            "-u", self.target_url,
            "--batch",
            "--risk=2", "--level=3",
            "--forms",           # discover and test form fields
            "--crawl=2",         # crawl 2 levels deep
            "--output-dir", str(output_dir),
            "--flush-session",   # start fresh each run
        ]

        def _parse_sqlmap_findings(stdout: str, out_dir: pathlib.Path) -> list[dict]:
            """Parse sqlmap stdout + output-dir CSV files into normalised findings."""
            findings: list[dict] = []

            # ------ 1. Parse stdout lines for confirmed injections ------
            for line in stdout.splitlines():
                line_l = line.lower()
                # sqlmap lines like: "Parameter: id (GET) is vulnerable. Do you want ..."
                # or: "sqlmap identified the following injection point(s)"
                if any(kw in line_l for kw in [
                    "is vulnerable", "injection point", "parameter:", "payload:",
                    "type: boolean-based", "type: time-based", "type: union",
                    "type: error-based", "type: stacked",
                ]):
                    # Extract parameter name if present
                    param = ""
                    m = re.search(r"parameter:\s*(['\"]?)(\w+)\1", line, re.I)
                    if m:
                        param = m.group(2)
                    severity = "HIGH" if "inject" in line_l else "MEDIUM"
                    finding: dict = {
                        "name": f"SQL Injection — {param or 'unknown parameter'}",
                        "description": line.strip()[:300],
                        "severity": severity,
                        "source": "sqlmap",
                        "url": self.target_url,
                        "parameter": param,
                    }
                    findings.append(enrich_finding(finding))

            # ------ 2. Parse output-dir CSV report files ------
            for csv_path in out_dir.rglob("*.csv"):
                try:
                    import csv as _csv
                    with csv_path.open(newline="", encoding="utf-8", errors="ignore") as f:
                        reader = _csv.DictReader(f)
                        for row in reader:
                            param = row.get("Parameter", row.get("parameter", ""))
                            vuln_type = row.get("Type", row.get("type", "SQL Injection"))
                            payload = row.get("Payload", row.get("payload", ""))
                            finding = {
                                "name": f"{vuln_type} — {param}",
                                "description": f"Parameter '{param}' is vulnerable to {vuln_type}. Payload: {payload[:150]}",
                                "severity": "HIGH",
                                "source": "sqlmap",
                                "url": row.get("URL", self.target_url),
                                "parameter": param,
                                "payload": payload[:300],
                            }
                            findings.append(enrich_finding(finding))
                except Exception:
                    pass

            # Deduplicate by (name + url)
            seen: set[str] = set()
            unique: list[dict] = []
            for f in findings:
                key = f"{f.get('name', '')}::{f.get('url', '')}"
                if key not in seen:
                    seen.add(key)
                    unique.append(f)
            return unique[:30]

        # --- Attempt 1: Docker sqlmap (preferred — clean environment) ---
        try:
            docker_check = subprocess.run(
                ["docker", "info"], capture_output=True, text=True, timeout=5,
            )
            if docker_check.returncode == 0:
                host_out = str(output_dir)
                docker_args = [
                    "-u", self.target_url,
                    "--batch", "--risk=2", "--level=3",
                    "--forms", "--crawl=2",
                    "--output-dir=/output",
                    "--flush-session",
                ]
                cmd = [
                    "docker", "run", "--rm",
                    "--network", "host",
                    "-v", f"{host_out}:/output",
                    "sqlmapproject/sqlmap:latest",
                ] + docker_args
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
                stdout_text = result.stdout + result.stderr
                findings = _parse_sqlmap_findings(stdout_text, output_dir)
                return {
                    "available": True,
                    "findings": findings,
                    "finding_count": len(findings),
                    "error": None,
                    "via": "docker",
                    "output_sample": stdout_text[-500:],
                }
        except FileNotFoundError:
            pass

        # --- Attempt 2: local sqlmap ---
        try:
            result = subprocess.run(
                ["sqlmap"] + base_args + ["--json-output"],
                capture_output=True, text=True, timeout=600,
            )
            stdout_text = result.stdout + result.stderr
            findings = _parse_sqlmap_findings(stdout_text, output_dir)
            return {
                "available": True,
                "findings": findings,
                "finding_count": len(findings),
                "error": None,
                "via": "native",
                "output_sample": stdout_text[-500:],
            }
        except FileNotFoundError:
            return {
                "available": False, "findings": [], "finding_count": 0,
                "error": "sqlmap not installed. Install via pip or Docker: docker pull sqlmapproject/sqlmap",
            }
        except Exception as e:
            return {"available": False, "findings": [], "finding_count": 0, "error": str(e)}

    def _run_wapiti(self) -> dict:
        """
        Run Wapiti web vulnerability scanner.

        Output mode: JSON (`--format json`) written to a temp directory.
        The JSON report is parsed into a normalised findings list.

        Wapiti scope: `--scope url` to limit to the target origin,
        `--max-links-per-page 30` to avoid runaway crawl.
        """
        import urllib.parse as _up
        output_dir = self.project_dir / ".pakalon" / "wapiti-results"
        output_dir.mkdir(parents=True, exist_ok=True)
        json_report = output_dir / "wapiti-report.json"

        # Common args for both Docker and native
        wapiti_args = [
            "-u", self.target_url,
            "--scope", "url",
            "--max-links-per-page", "30",
            "--format", "json",
            "-o", "/results/wapiti-report.json",
        ]

        def _parse_wapiti_json(report_path: pathlib.Path) -> list[dict]:
            """Parse Wapiti JSON report into normalised finding list."""
            findings: list[dict] = []
            if not report_path.exists():
                return findings
            try:
                data = json.loads(report_path.read_text(encoding="utf-8"))
                # Report structure: {"vulnerabilities": {"SQL Injection": [...]}, "anomalies": {...}}
                for category, items in data.get("vulnerabilities", {}).items():
                    if not isinstance(items, list):
                        continue
                    for item in items[:20]:
                        finding: dict = {
                            "name": category,
                            "description": item.get("info", item.get("description", category))[:400],
                            "severity": item.get("level", "MEDIUM"),
                            "source": "wapiti",
                            "url": item.get("path", self.target_url),
                            "method": item.get("method", "GET"),
                            "parameter": item.get("parameter", ""),
                            "curl_command": item.get("curl_command", ""),
                        }
                        findings.append(enrich_finding(finding))
                for category, items in data.get("anomalies", {}).items():
                    if not isinstance(items, list):
                        continue
                    for item in items[:10]:
                        finding = {
                            "name": f"Anomaly: {category}",
                            "description": item.get("info", "")[:400],
                            "severity": "LOW",
                            "source": "wapiti",
                            "url": item.get("path", self.target_url),
                        }
                        findings.append(enrich_finding(finding))
            except Exception:
                pass
            return findings[:40]

        # --- Attempt 1: Docker Wapiti ---
        try:
            docker_check = subprocess.run(
                ["docker", "info"], capture_output=True, text=True, timeout=5,
            )
            if docker_check.returncode == 0:
                docker_out = str(output_dir)
                docker_cmd = [
                    "docker", "run", "--rm",
                    "--network", "host",
                    "-v", f"{docker_out}:/results",
                    "wapiti3/wapiti:latest",
                    "-u", self.target_url,
                    "--scope", "url",
                    "--max-links-per-page", "30",
                    "--format", "json",
                    "-o", "/results/wapiti-report.json",
                ]
                result = subprocess.run(docker_cmd, capture_output=True, text=True, timeout=600)
                findings = _parse_wapiti_json(json_report)
                return {
                    "available": True,
                    "findings": findings,
                    "finding_count": len(findings),
                    "error": None,
                    "via": "docker",
                    "output_sample": (result.stdout + result.stderr)[-500:],
                }
        except FileNotFoundError:
            pass

        # --- Attempt 2: local wapiti ---
        try:
            native_cmd = [
                "wapiti",
                "-u", self.target_url,
                "--scope", "url",
                "--max-links-per-page", "30",
                "--format", "json",
                "-o", str(json_report),
            ]
            result = subprocess.run(native_cmd, capture_output=True, text=True, timeout=600)
            findings = _parse_wapiti_json(json_report)
            return {
                "available": True,
                "findings": findings,
                "finding_count": len(findings),
                "error": None,
                "via": "native",
            }
        except FileNotFoundError:
            return {
                "available": False, "findings": [], "finding_count": 0,
                "error": "wapiti not installed. Install via pip: pip install wapiti3 or use Docker",
            }
        except Exception as e:
            return {"available": False, "findings": [], "finding_count": 0, "error": str(e)}

    def _run_xsstrike(self) -> dict:
        """
        Run XSStrike for XSS vulnerability testing.

        Modes:
          - `--crawl`  : crawl-based discovery of XSS vectors
          - `--json`   : machine-readable output (XSStrike 3.2+)
          - `--blind`  : include blind XSS payloads

        The JSON output is parsed into normalised findings.
        stdout fallback parsing covers older XSStrike versions without `--json`.
        """
        output_dir = self.project_dir / ".pakalon" / "xsstrike-results"
        output_dir.mkdir(parents=True, exist_ok=True)
        json_report = output_dir / "xsstrike-report.json"

        def _parse_xsstrike_output(stdout: str, json_path: pathlib.Path) -> list[dict]:
            """Parse XSStrike JSON report or stdout for XSS findings."""
            findings: list[dict] = []

            # 1. JSON report (XSStrike ≥ 3.2 with --json flag)
            if json_path.exists():
                try:
                    data = json.loads(json_path.read_text(encoding="utf-8"))
                    for item in (data if isinstance(data, list) else data.get("results", [])):
                        finding: dict = {
                            "name": "Cross-Site Scripting (XSS)",
                            "description": item.get("description", item.get("payload", "XSS vector found"))[:400],
                            "severity": "HIGH",
                            "source": "xsstrike",
                            "url": item.get("url", self.target_url),
                            "parameter": item.get("parameter", item.get("param", "")),
                            "payload": item.get("payload", "")[:300],
                        }
                        findings.append(enrich_finding(finding))
                    return findings[:30]
                except Exception:
                    pass

            # 2. Parse stdout — XSStrike outputs reflected/DOM/etc. per-line
            for line in stdout.splitlines():
                line_l = line.lower()
                if any(kw in line_l for kw in [
                    "xss found", "vulnerable", "reflected xss", "dom xss",
                    "stored xss", "possible xss", "xss vector",
                    "[+]", "payload works",
                ]):
                    # Try to extract payload between quotes or after "payload:"
                    payload = ""
                    pm = re.search(r"payload[:\s]+(['\"]?)(.+)\1$", line, re.I)
                    if pm:
                        payload = pm.group(2).strip()[:300]
                    finding = {
                        "name": "Cross-Site Scripting (XSS)",
                        "description": line.strip()[:300],
                        "severity": "HIGH",
                        "source": "xsstrike",
                        "url": self.target_url,
                        "payload": payload,
                    }
                    findings.append(enrich_finding(finding))
            return findings[:30]

        # --- Attempt 1: Docker XSStrike ---
        try:
            docker_check = subprocess.run(
                ["docker", "info"], capture_output=True, text=True, timeout=5,
            )
            if docker_check.returncode == 0:
                host_out = str(output_dir)
                docker_cmd = [
                    "docker", "run", "--rm",
                    "--network", "host",
                    "-v", f"{host_out}:/output",
                    "hahwul/xsstrike:latest",
                    "--url", self.target_url,
                    "--crawl",
                    "--json", "/output/xsstrike-report.json",
                ]
                result = subprocess.run(docker_cmd, capture_output=True, text=True, timeout=300)
                stdout_text = result.stdout + result.stderr
                findings = _parse_xsstrike_output(stdout_text, json_report)
                return {
                    "available": True,
                    "findings": findings,
                    "finding_count": len(findings),
                    "error": None,
                    "via": "docker",
                    "output_sample": stdout_text[-500:],
                }
        except FileNotFoundError:
            pass

        # --- Attempt 2: local xsstrike ---
        try:
            native_cmd = [
                "python", "-m", "xsstrike",
                "--url", self.target_url,
                "--crawl",
                "--json", str(json_report),
            ]
            result = subprocess.run(native_cmd, capture_output=True, text=True, timeout=300)
            # Try older args style if the above fails
            if result.returncode != 0:
                native_cmd = [
                    "python", "-m", "xsstrike",
                    "-u", self.target_url,
                    "--crawl",
                ]
                result = subprocess.run(native_cmd, capture_output=True, text=True, timeout=300)
            stdout_text = result.stdout + result.stderr
            findings = _parse_xsstrike_output(stdout_text, json_report)
            return {
                "available": True,
                "findings": findings,
                "finding_count": len(findings),
                "error": None,
                "via": "native",
                "output_sample": stdout_text[-500:],
            }
        except FileNotFoundError:
            return {
                "available": False, "findings": [], "finding_count": 0,
                "error": "xsstrike not installed. Install via: pip install xsstrike or use Docker",
            }
        except Exception as e:
            return {"available": False, "findings": [], "finding_count": 0, "error": str(e)}

    def _summarize(self, results: dict) -> dict:
        high = 0
        medium = 0
        low = 0
        total = 0

        def _tally(findings: list[dict]) -> None:
            nonlocal high, medium, low, total
            for f in findings:
                total += 1
                sev = str(f.get("severity", "")).upper()
                if sev in ("HIGH", "CRITICAL"):
                    high += 1
                elif sev == "MEDIUM":
                    medium += 1
                else:
                    low += 1

        # Security headers
        hdr = results.get("security_headers", {})
        missing_headers = len(hdr.get("missing", []))
        if missing_headers >= 3:
            high += 1
        total += missing_headers

        # ZAP alerts
        for alert in results.get("zap", {}).get("findings", results.get("zap", {}).get("alerts", [])):
            total += 1
            risk = str(alert.get("severity", alert.get("risk", ""))).upper()
            if risk in ("HIGH", "CRITICAL"):
                high += 1
            elif risk == "MEDIUM":
                medium += 1
            else:
                low += 1

        # SQLMap
        _tally(results.get("sqlmap", {}).get("findings", []))

        # Wapiti
        _tally(results.get("wapiti", {}).get("findings", []))

        # XSStrike
        _tally(results.get("xsstrike", {}).get("findings", []))

        # Nikto (findings may be raw dicts or strings)
        for item in results.get("nikto", {}).get("findings", []):
            if isinstance(item, dict):
                total += 1
                if str(item.get("severity", "")).upper() in ("HIGH", "CRITICAL"):
                    high += 1
                elif str(item.get("severity", "")).upper() == "MEDIUM":
                    medium += 1
                else:
                    low += 1
            elif isinstance(item, str):
                total += 1
                low += 1

        # nmap open ports → informational
        nmap_open = len(results.get("nmap", {}).get("open_ports", []))
        total += nmap_open
        low += nmap_open

        per_tool: dict[str, int] = {}
        for tool in ("zap", "sqlmap", "wapiti", "xsstrike", "nikto"):
            per_tool[tool] = len(results.get(tool, {}).get("findings", []))

        return {
            "total_findings": total,
            "high_severity": high,
            "medium_severity": medium,
            "low_severity": low,
            "per_tool": per_tool,
            "passed": high == 0,
        }
