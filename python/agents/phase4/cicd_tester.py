"""
cicd_tester.py — Phase 4 Sub-Agent 4: CI/CD Pipeline Testing.
Scans CI/CD configuration files, validates pipeline correctness and security,
and suggests improvements. Integrates with GitHub Actions, Jenkins, Docker.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
from typing import Any

import httpx


class CICDTester:
    """
    Scans and validates CI/CD pipeline configurations.
    Supports: GitHub Actions, Jenkins, Dockerfile, docker-compose,
              Travis CI, CircleCI, Bitbucket Pipelines.
    """

    SUPPORTED_FILES = [
        ".github/workflows",        # GitHub Actions (directory)
        "Jenkinsfile",
        "Dockerfile",
        "docker-compose.yml",
        "docker-compose.yaml",
        ".travis.yml",
        ".circleci/config.yml",
        "bitbucket-pipelines.yml",
        "azure-pipelines.yml",
        ".gitlab-ci.yml",
        "Makefile",
    ]

    # Patterns indicating security issues in CI/CD configs
    SECURITY_PATTERNS = [
        (r"--privileged", "HIGH", "Docker container runs with --privileged flag"),
        (r"password\s*[:=]\s*['\"]?\w", "HIGH", "Hardcoded password in config"),
        (r"secret\s*[:=]\s*['\"]?\w+['\"]", "MEDIUM", "Potential hardcoded secret"),
        (r"api[_-]?key\s*[:=]\s*['\"]?\w", "HIGH", "Hardcoded API key"),
        (r"AWS_SECRET|AWS_ACCESS|GITHUB_TOKEN\s*=\s*['\"]?\w", "HIGH", "Hardcoded cloud credential"),
        (r"curl\s+.*http://", "MEDIUM", "Insecure HTTP in CI download step"),
        (r"chmod\s+777", "MEDIUM", "Overly permissive chmod 777"),
        (r"sudo\s+", "LOW", "sudo usage in CI step"),
        (r"eval\s+\$", "HIGH", "eval with variable expansion — potential injection"),
    ]

    # Best-practice checks
    BEST_PRACTICE_PATTERNS = [
        ("test", r"run:\s*(npm\s+test|pytest|go test|cargo test|mvn test|gradle test)", "MISSING_TESTS",
         "No test execution step found in pipeline"),
        ("lint", r"(eslint|flake8|pylint|golangci|rubocop|cargo\s+clippy|npm\s+run\s+lint)", "MISSING_LINT",
         "No linting step found in pipeline"),
        ("dependency_scan", r"(npm\s+audit|pip\s+audit|safety\s+check|snyk|trivy|anchore)", "MISSING_DEPENDENCY_SCAN",
         "No dependency vulnerability scanning found"),
        ("secret_scan", r"(gitleaks|trufflehog|detect-secrets|git-secrets)", "MISSING_SECRET_SCAN",
         "No secret scanning step found"),
        ("sast", r"(semgrep|sonarqube|sonar-scanner|bandit|eslint\s.*security)", "MISSING_SAST",
         "No SAST (Static Analysis Security Testing) step found"),
        ("build_cache", r"(cache:|uses:.*cache)", "MISSING_BUILD_CACHE",
         "No build caching configured — pipeline will be slower"),
        ("pinned_actions", r"uses:\s*\w+/\w+@(main|master|HEAD)", "UNPINNED_ACTIONS",
         "GitHub Actions not pinned to SHA — supply chain risk"),
    ]

    def __init__(self, project_dir: str, user_plan: str = "free") -> None:
        self.project_dir = pathlib.Path(project_dir)
        self.user_plan = user_plan
        self.findings: list[dict[str, Any]] = []
        self.missing_practices: list[dict[str, Any]] = []
        self.pipeline_files: list[str] = []
        self.summary: dict[str, Any] = {}

    def _load_pipeline_files(self) -> dict[str, str]:
        """Discover and load all CI/CD configuration files."""
        loaded: dict[str, str] = {}

        for rel_path in self.SUPPORTED_FILES:
            full_path = self.project_dir / rel_path
            if full_path.is_dir():
                # Directory (e.g. .github/workflows/)
                for yml_file in full_path.glob("*.yml"):
                    try:
                        loaded[str(yml_file.relative_to(self.project_dir))] = yml_file.read_text()
                        self.pipeline_files.append(str(yml_file.relative_to(self.project_dir)))
                    except Exception:
                        pass
                for yml_file in full_path.glob("*.yaml"):
                    try:
                        loaded[str(yml_file.relative_to(self.project_dir))] = yml_file.read_text()
                        self.pipeline_files.append(str(yml_file.relative_to(self.project_dir)))
                    except Exception:
                        pass
            elif full_path.is_file():
                try:
                    loaded[rel_path] = full_path.read_text()
                    self.pipeline_files.append(rel_path)
                except Exception:
                    pass

        return loaded

    def _check_security(self, filename: str, content: str) -> None:
        """Scan file content for security anti-patterns."""
        for pattern, severity, description in self.SECURITY_PATTERNS:
            for match in re.finditer(pattern, content, re.IGNORECASE):
                line_num = content[: match.start()].count("\n") + 1
                self.findings.append({
                    "file": filename,
                    "line": line_num,
                    "severity": severity,
                    "rule": pattern,
                    "description": description,
                    "snippet": content[max(0, match.start() - 20): match.end() + 20].strip(),
                })

    def _check_best_practices(self, all_content: str) -> None:
        """Check for missing CI/CD best practices across ALL pipeline files combined."""
        for _name, pattern, issue_code, description in self.BEST_PRACTICE_PATTERNS:
            if not re.search(pattern, all_content, re.IGNORECASE):
                self.missing_practices.append({
                    "issue_code": issue_code,
                    "description": description,
                    "severity": "MEDIUM",
                    "recommendation": f"Add a step for: {description.lower().replace('no ', '').replace(' found', '')}",
                })

    def _check_dockerfile(self, filename: str, content: str) -> None:
        """Docker-specific security checks."""
        # Running as root
        if not re.search(r"^USER\s+\w", content, re.MULTILINE):
            self.findings.append({
                "file": filename,
                "line": None,
                "severity": "MEDIUM",
                "rule": "DOCKER_ROOT_USER",
                "description": "Dockerfile does not define a non-root USER — container runs as root",
                "snippet": "",
            })
        # Using :latest tag
        for match in re.finditer(r"FROM\s+\S+:latest", content, re.IGNORECASE):
            line_num = content[: match.start()].count("\n") + 1
            self.findings.append({
                "file": filename,
                "line": line_num,
                "severity": "LOW",
                "rule": "DOCKER_LATEST_TAG",
                "description": "Using :latest tag is non-deterministic — pin to a specific version",
                "snippet": match.group(0),
            })
        # ADD instead of COPY
        for match in re.finditer(r"^ADD\s+", content, re.MULTILINE):
            line_num = content[: match.start()].count("\n") + 1
            self.findings.append({
                "file": filename,
                "line": line_num,
                "severity": "LOW",
                "rule": "DOCKER_ADD_INSECURE",
                "description": "Use COPY instead of ADD (unless extracting archives) — ADD can fetch remote URLs",
                "snippet": match.group(0).strip(),
            })

    def _get_llm_suggestions(self, findings_summary: str) -> list[dict]:
        """Use LLM to provide human-readable fix suggestions for CI/CD issues."""
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key or self.user_plan != "pro":
            return []

        try:
            prompt = f"""You are a DevSecOps expert reviewing CI/CD pipeline issues.

Issues found:
{findings_summary}

Provide specific, actionable fix suggestions for each issue. Return JSON array:
[{{"issue": "issue_code or description", "fix": "exact YAML/config snippet to fix it", "explanation": "why this fix works"}}]

Be concise. Max 5 suggestions. Return ONLY valid JSON array."""

            response = httpx.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": os.environ.get("PAKALON_MODEL", "anthropic/claude-3-5-haiku"),
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 1500,
                },
                timeout=45,
            )
            response.raise_for_status()
            raw = response.json()["choices"][0]["message"]["content"]
            match = re.search(r"\[.*\]", raw, re.DOTALL)
            if match:
                return json.loads(match.group())
        except Exception:
            pass
        return []

    def run(self) -> dict[str, Any]:
        """Execute all CI/CD pipeline checks. Returns structured results."""
        pipeline_files = self._load_pipeline_files()

        if not pipeline_files:
            return {
                "status": "NO_PIPELINE",
                "message": "No CI/CD pipeline files found in project.",
                "files_checked": [],
                "findings": [],
                "missing_practices": [],
                "suggestions": [],
                "summary": {
                    "total_findings": 0,
                    "high_severity": 0,
                    "medium_severity": 0,
                    "low_severity": 0,
                    "missing_practices": 0,
                    "passed": False,
                    "recommendation": "Create a CI/CD pipeline (e.g., .github/workflows/ci.yml)",
                },
            }

        # Run checks per file
        all_content = "\n".join(pipeline_files.values())
        for filename, content in pipeline_files.items():
            self._check_security(filename, content)
            if "dockerfile" in filename.lower():
                self._check_dockerfile(filename, content)

        self._check_best_practices(all_content)

        high = sum(1 for f in self.findings if f["severity"] == "HIGH")
        medium = sum(1 for f in self.findings if f["severity"] == "MEDIUM")
        low = sum(1 for f in self.findings if f["severity"] == "LOW")

        # LLM suggestions for high/medium issues
        top_issues = "\n".join(
            f"- [{f['severity']}] {f['description']} (in {f['file']})"
            for f in self.findings[:8]
            if f["severity"] in ("HIGH", "MEDIUM")
        )
        top_issues += "\n".join(
            f"- [MISSING] {p['description']}" for p in self.missing_practices[:5]
        )
        suggestions = self._get_llm_suggestions(top_issues) if (top_issues and self.user_plan == "pro") else []

        result = {
            "status": "FINDINGS" if (self.findings or self.missing_practices) else "CLEAN",
            "files_checked": list(pipeline_files.keys()),
            "findings": self.findings,
            "missing_practices": self.missing_practices,
            "suggestions": suggestions,
            "summary": {
                "total_findings": len(self.findings),
                "high_severity": high,
                "medium_severity": medium,
                "low_severity": low,
                "missing_practices": len(self.missing_practices),
                "passed": high == 0,
                "recommendation": (
                    "Critical CI/CD security issues require immediate remediation."
                    if high > 0
                    else "Pipeline structure is acceptable. Review medium/low findings."
                    if medium > 0
                    else "CI/CD pipeline passes all security checks."
                ),
            },
        }
        return result

    def write_subagent_md(self, out_dir: str, results: dict[str, Any]) -> str:
        """Write subagent-5.md with CI/CD review results."""
        out_path = pathlib.Path(out_dir) / "subagent-5.md"
        summary = results.get("summary", {})
        findings = results.get("findings", [])
        missing = results.get("missing_practices", [])
        suggestions = results.get("suggestions", [])

        lines = [
            "# Phase 4 — Sub-Agent 4: CI/CD Pipeline Review",
            "",
            f"**Status:** {results.get('status', 'UNKNOWN')}",
            f"**Files Checked:** {', '.join(results.get('files_checked', [])) or 'None found'}",
            "",
            "## Summary",
            "",
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| Total findings | {summary.get('total_findings', 0)} |",
            f"| High severity | {summary.get('high_severity', 0)} |",
            f"| Medium severity | {summary.get('medium_severity', 0)} |",
            f"| Low severity | {summary.get('low_severity', 0)} |",
            f"| Missing best practices | {summary.get('missing_practices', 0)} |",
            f"| Overall pass | {'✅' if summary.get('passed') else '❌'} |",
            "",
        ]

        if findings:
            lines += ["## Security Findings", ""]
            for f in findings:
                sev_icon = {"HIGH": "🔴", "MEDIUM": "🟡", "LOW": "🔵"}.get(f["severity"], "⚪")
                loc = f" (line {f['line']})" if f.get("line") else ""
                lines.append(f"- {sev_icon} **[{f['severity']}]** `{f['file']}`{loc}: {f['description']}")
                if f.get("snippet"):
                    lines.append(f"  ```\n  {f['snippet']}\n  ```")
            lines.append("")

        if missing:
            lines += ["## Missing Best Practices", ""]
            for m in missing:
                lines.append(f"- ⚠️ **{m['issue_code']}**: {m['description']}")
                lines.append(f"  *Recommendation:* {m['recommendation']}")
            lines.append("")

        if suggestions:
            lines += ["## Fix Suggestions", ""]
            for s in suggestions:
                lines.append(f"### {s.get('issue', 'Issue')}")
                lines.append(s.get("explanation", ""))
                if s.get("fix"):
                    lines.append(f"```yaml\n{s['fix']}\n```")
                lines.append("")

        lines += [
            "## Recommendation",
            "",
            summary.get("recommendation", "Review CI/CD pipeline configuration."),
        ]

        out_path.write_text("\n".join(lines))
        return str(out_path)
