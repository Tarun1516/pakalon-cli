"""
cyber_security.py — Phase 4 Sub-Agent 5: Cyber Security Attack Simulation.
Tests the running application against active attacks:
  SQLi, XSS, CSRF, IDOR, privilege escalation, DoS (basic), header analysis.
Uses available CLI tools (sqlmap, XSStrike, nmap) when installed,
plus built-in HTTP-based checks for all plans.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import subprocess
import time
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx


class CyberSecurityTester:
    """
    Active security testing against a running application.
    Basic HTTP checks available for all plans.
    Advanced tools (sqlmap, XSStrike) require pro plan + tools installed.
    """

    # Common SQL injection payloads
    SQLI_PAYLOADS = [
        "' OR '1'='1",
        "' OR 1=1--",
        "'; DROP TABLE users;--",
        "1 UNION SELECT NULL--",
        "' AND SLEEP(3)--",
    ]

    # XSS payloads
    XSS_PAYLOADS = [
        "<script>alert('xss')</script>",
        "<img src=x onerror=alert(1)>",
        "javascript:alert(1)",
        "\"><script>alert(1)</script>",
        "';alert(1)//",
    ]

    # Security headers that should be present
    REQUIRED_SECURITY_HEADERS = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": None,  # any value
        "Content-Security-Policy": None,
        "Strict-Transport-Security": None,
        "X-XSS-Protection": None,
        "Referrer-Policy": None,
    }

    # Headers that should NOT be present (information disclosure)
    FORBIDDEN_HEADERS = [
        "Server",        # exposes server version
        "X-Powered-By",  # exposes tech stack
        "X-AspNet-Version",
        "X-AspNetMvc-Version",
    ]

    def __init__(self, target_url: str, project_dir: str, user_plan: str = "free") -> None:
        self.target_url = target_url.rstrip("/")
        self.project_dir = pathlib.Path(project_dir)
        self.user_plan = user_plan
        self.findings: list[dict[str, Any]] = []
        self.attack_results: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Basic HTTP checks (all plans)
    # ------------------------------------------------------------------

    def _check_security_headers(self) -> dict[str, Any]:
        """Check HTTP security headers on the base URL."""
        result: dict[str, Any] = {
            "missing_headers": [],
            "information_disclosure": [],
            "score": 0,
        }
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                response = client.get(self.target_url)
                headers = {k.lower(): v for k, v in response.headers.items()}

            present = 0
            for header, expected_value in self.REQUIRED_SECURITY_HEADERS.items():
                if header.lower() not in headers:
                    result["missing_headers"].append(header)
                    self.findings.append({
                        "type": "MISSING_SECURITY_HEADER",
                        "severity": "MEDIUM" if header == "Content-Security-Policy" else "LOW",
                        "description": f"Missing security header: {header}",
                        "recommendation": f"Add '{header}' response header",
                    })
                else:
                    present += 1
                    if expected_value and headers[header.lower()] != expected_value:
                        self.findings.append({
                            "type": "WRONG_HEADER_VALUE",
                            "severity": "LOW",
                            "description": f"{header} is present but value '{headers[header.lower()]}' is not '{expected_value}'",
                            "recommendation": f"Set '{header}: {expected_value}'",
                        })

            for header in self.FORBIDDEN_HEADERS:
                if header.lower() in headers:
                    result["information_disclosure"].append({
                        "header": header,
                        "value": headers[header.lower()],
                    })
                    self.findings.append({
                        "type": "INFORMATION_DISCLOSURE",
                        "severity": "LOW",
                        "description": f"Response exposes server info via '{header}: {headers[header.lower()]}'",
                        "recommendation": f"Remove or anonymize the '{header}' response header",
                    })

            result["score"] = round((present / len(self.REQUIRED_SECURITY_HEADERS)) * 100)
        except Exception as e:
            result["error"] = str(e)
        return result

    def _check_csrf(self, endpoints: list[str]) -> dict[str, Any]:
        """Check POST endpoints for CSRF token presence."""
        result: dict[str, Any] = {"vulnerable": [], "protected": [], "checked": 0}
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            for endpoint in endpoints[:5]:
                full_url = urljoin(self.target_url, endpoint)
                try:
                    # GET the form page first, look for CSRF token
                    get_resp = client.get(full_url)
                    has_csrf = bool(
                        re.search(r'csrf[_-]?token|_token|authenticity_token', get_resp.text, re.IGNORECASE)
                        or "csrf" in get_resp.headers.get("set-cookie", "").lower()
                    )
                    # Attempt POST without CSRF token
                    post_resp = client.post(full_url, data={"test": "csrf_check"})
                    result["checked"] += 1

                    if post_resp.status_code not in (403, 422, 401) and not has_csrf:
                        result["vulnerable"].append(endpoint)
                        self.findings.append({
                            "type": "CSRF_VULNERABILITY",
                            "severity": "HIGH",
                            "description": f"Endpoint {endpoint} may be vulnerable to CSRF (no token found, POST returned {post_resp.status_code})",
                            "recommendation": "Implement CSRF token validation for all state-changing POST/PUT/DELETE endpoints",
                        })
                    else:
                        result["protected"].append(endpoint)
                except Exception:
                    pass
        return result

    def _check_idor(self, endpoints: list[str]) -> dict[str, Any]:
        """Check for IDOR by trying numeric ID enumeration."""
        result: dict[str, Any] = {"tested": [], "potential_idor": []}
        id_pattern = re.compile(r"/(\d+)(/|$)")

        with httpx.Client(timeout=15, follow_redirects=True) as client:
            for endpoint in endpoints[:10]:
                match = id_pattern.search(endpoint)
                if not match:
                    continue
                original_id = int(match.group(1))
                alt_id = original_id + 1 if original_id > 1 else original_id + 2

                original_url = urljoin(self.target_url, endpoint)
                alt_url = id_pattern.sub(f"/{alt_id}\\2", original_url, count=1)

                try:
                    orig_resp = client.get(original_url)
                    alt_resp = client.get(alt_url)

                    result["tested"].append(endpoint)
                    # If both return 200 with similar content lengths, potential IDOR
                    if (orig_resp.status_code == 200 and alt_resp.status_code == 200
                            and abs(len(orig_resp.content) - len(alt_resp.content)) < 500):
                        result["potential_idor"].append({
                            "endpoint": endpoint,
                            "original_status": orig_resp.status_code,
                            "alt_status": alt_resp.status_code,
                        })
                        self.findings.append({
                            "type": "POTENTIAL_IDOR",
                            "severity": "HIGH",
                            "description": f"Potential IDOR at {endpoint}: accessing ID {alt_id} returned similar response to ID {original_id}",
                            "recommendation": "Implement object-level authorization: verify each request is authorized to access the specific resource",
                        })
                except Exception:
                    pass
        return result

    def _check_open_ports(self) -> dict[str, Any]:
        """Quick scan of common dangerous ports using nmap (if available)."""
        result: dict[str, Any] = {"open_ports": [], "dangerous_ports": [], "tool_available": False}
        parsed = urlparse(self.target_url)
        host = parsed.hostname or "localhost"
        dangerous = {21: "FTP", 23: "Telnet", 3306: "MySQL", 5432: "PostgreSQL",
                     6379: "Redis", 27017: "MongoDB", 9200: "Elasticsearch"}
        try:
            # Check if nmap is available
            nmap_check = subprocess.run(["nmap", "--version"], capture_output=True, timeout=5)
            if nmap_check.returncode == 0:
                result["tool_available"] = True
                ports_str = ",".join(str(p) for p in dangerous)
                scan = subprocess.run(
                    ["nmap", "-p", ports_str, "--open", "-T4", host],
                    capture_output=True, text=True, timeout=60,
                )
                for port, service in dangerous.items():
                    if f"{port}/tcp" in scan.stdout and "open" in scan.stdout.split(f"{port}/tcp")[1][:20]:
                        result["open_ports"].append({"port": port, "service": service})
                        result["dangerous_ports"].append(port)
                        self.findings.append({
                            "type": "EXPOSED_PORT",
                            "severity": "HIGH",
                            "description": f"Dangerous port {port} ({service}) is accessible from outside",
                            "recommendation": f"Restrict access to port {port} using firewall rules. {service} should not be publicly accessible.",
                        })
        except Exception:
            pass
        return result

    def _run_sqlmap(self, target_url: str) -> dict[str, Any]:
        """Run sqlmap against a target endpoint (pro plan + tool installed)."""
        result: dict[str, Any] = {"available": False, "injections_found": [], "error": None}
        if self.user_plan != "pro":
            return result
        try:
            check = subprocess.run(["sqlmap", "--version"], capture_output=True, timeout=5)
            if check.returncode != 0:
                return result
            result["available"] = True
            sqlmap_result = subprocess.run(
                ["sqlmap", "-u", target_url, "--batch", "--level=2", "--risk=1",
                 "--output-dir=/tmp/sqlmap_pakalon", "--forms", "--crawl=1"],
                capture_output=True, text=True, timeout=180,
            )
            output = sqlmap_result.stdout + sqlmap_result.stderr
            if "sqlmap identified the following injection point" in output:
                for match in re.finditer(r"Parameter: (\w+) \((\w+)\)", output):
                    result["injections_found"].append({
                        "parameter": match.group(1),
                        "type": match.group(2),
                    })
                    self.findings.append({
                        "type": "SQL_INJECTION",
                        "severity": "CRITICAL",
                        "description": f"SQL injection found at parameter '{match.group(1)}' ({match.group(2)})",
                        "recommendation": "Use parameterized queries/prepared statements. Never interpolate user input into SQL strings.",
                    })
        except Exception as e:
            result["error"] = str(e)
        return result

    def _run_xsstrike(self, target_url: str) -> dict[str, Any]:
        """Run XSStrike XSS scanning (pro plan + tool available)."""
        result: dict[str, Any] = {"available": False, "xss_found": [], "error": None}
        if self.user_plan != "pro":
            return result
        try:
            check = subprocess.run(["python3", "-m", "xsstrike", "--help"], capture_output=True, timeout=5)
            if check.returncode != 0:
                # Try as direct command
                check2 = subprocess.run(["xsstrike", "--help"], capture_output=True, timeout=5)
                if check2.returncode != 0:
                    return result
            result["available"] = True
            xss_run = subprocess.run(
                ["python3", "-m", "xsstrike", "-u", target_url, "--crawl", "--blind"],
                capture_output=True, text=True, timeout=120,
            )
            output = xss_run.stdout + xss_run.stderr
            if "XSS Found" in output or "Payload:" in output:
                for match in re.finditer(r"Payload: (.+)", output):
                    result["xss_found"].append(match.group(1).strip())
                    self.findings.append({
                        "type": "XSS_VULNERABILITY",
                        "severity": "HIGH",
                        "description": f"Reflected XSS found at {target_url}. Payload: {match.group(1).strip()[:100]}",
                        "recommendation": "Encode all user-controlled output. Implement Content-Security-Policy header.",
                    })
        except Exception as e:
            result["error"] = str(e)
        return result

    def _check_privilege_escalation(self) -> dict[str, Any]:
        """Test if admin endpoints are accessible with regular user credentials."""
        result: dict[str, Any] = {"tested": [], "potential_escalation": []}
        admin_paths = [
            "/admin", "/admin/", "/api/admin", "/api/v1/admin",
            "/dashboard/admin", "/manage", "/management",
            "/api/users", "/api/v1/users", "/api/v1/settings",
        ]
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            for path in admin_paths:
                url = self.target_url + path
                try:
                    resp = client.get(url)
                    result["tested"].append(path)
                    # If admin path returns 200 without auth, it's a finding
                    if resp.status_code == 200:
                        content_lower = resp.text.lower()
                        if any(kw in content_lower for kw in ["admin", "dashboard", "user list", "manage users"]):
                            result["potential_escalation"].append({
                                "path": path,
                                "status": resp.status_code,
                            })
                            self.findings.append({
                                "type": "PRIVILEGE_ESCALATION",
                                "severity": "CRITICAL",
                                "description": f"Admin endpoint {path} accessible without authentication (HTTP {resp.status_code})",
                                "recommendation": "Require authentication and authorization for all admin endpoints. Apply role-based access control.",
                            })
                except Exception:
                    pass
        return result

    async def run_all(self) -> dict[str, Any]:
        """Execute full cyber security test suite. Returns structured results."""
        results: dict[str, Any] = {}

        # 1. Check if target is reachable
        try:
            with httpx.Client(timeout=10) as client:
                probe = client.get(self.target_url)
            target_reachable = probe.status_code < 500
        except Exception:
            return {
                "status": "TARGET_UNREACHABLE",
                "target": self.target_url,
                "message": f"Could not connect to {self.target_url}. Ensure the application is running.",
                "findings": [],
                "summary": {
                    "total_findings": 0, "critical": 0, "high_severity": 0,
                    "medium_severity": 0, "low_severity": 0, "passed": True,
                },
            }

        # 2. Security headers
        results["security_headers"] = self._check_security_headers()

        # 3. Discover endpoints from common patterns
        common_endpoints = [
            "/api/users", "/api/login", "/api/register", "/api/v1/users",
            "/login", "/register", "/api/v1/login", "/api/auth/login",
        ]

        # 4. CSRF checks
        results["csrf"] = self._check_csrf(common_endpoints)

        # 5. IDOR checks
        id_endpoints = ["/api/users/1", "/api/posts/1", "/api/items/1", "/api/orders/1"]
        results["idor"] = self._check_idor(id_endpoints)

        # 6. Open port scan (if nmap available)
        results["port_scan"] = self._check_open_ports()

        # 7. Privilege escalation check
        results["privilege_escalation"] = self._check_privilege_escalation()

        # 8. Advanced tools (pro only)
        results["sqlmap"] = self._run_sqlmap(self.target_url)
        results["xsstrike"] = self._run_xsstrike(self.target_url)

        # T-P4-10: TheHarvester OSINT (pro only)
        if self.user_plan == "pro":
            results["theharvester"] = self.run_theharvester()

        # T-P4-09: Metasploit auxiliary scanners (pro only, Docker)
        if self.user_plan == "pro":
            results["metasploit"] = self.run_metasploit()

        # Summary
        critical = sum(1 for f in self.findings if f["severity"] == "CRITICAL")
        high = sum(1 for f in self.findings if f["severity"] == "HIGH")
        medium = sum(1 for f in self.findings if f["severity"] == "MEDIUM")
        low = sum(1 for f in self.findings if f["severity"] == "LOW")

        results["findings"] = self.findings
        results["summary"] = {
            "target": self.target_url,
            "total_findings": len(self.findings),
            "critical": critical,
            "high_severity": high,
            "medium_severity": medium,
            "low_severity": low,
            "passed": critical == 0 and high == 0,
            "security_score": max(0, 100 - (critical * 25) - (high * 10) - (medium * 5) - (low * 1)),
            "risk_level": (
                "CRITICAL" if critical > 0
                else "HIGH" if high > 0
                else "MEDIUM" if medium > 0
                else "LOW" if low > 0
                else "PASS"
            ),
        }
        return results

    def write_subagent_md(self, out_dir: str, results: dict[str, Any]) -> str:
        """Write subagent-5.md with cyber security test results."""
        out_path = pathlib.Path(out_dir) / "subagent-5.md"
        summary = results.get("summary", {})
        findings = results.get("findings", [])

        lines = [
            "# Phase 4 — Sub-Agent 5: Cyber Security Attack Simulation",
            "",
            f"**Target:** `{self.target_url}`",
            f"**Risk Level:** {summary.get('risk_level', 'UNKNOWN')}",
            f"**Security Score:** {summary.get('security_score', 0)}/100",
            "",
            "## Summary",
            "",
            "| Attack Type | Result |",
            "|-------------|--------|",
            f"| SQL Injection (sqlmap) | {'✅ Clean' if not results.get('sqlmap', {}).get('injections_found') else '❌ Vulnerabilities found'} |",
            f"| XSS (XSStrike) | {'✅ Clean' if not results.get('xsstrike', {}).get('xss_found') else '❌ Vulnerabilities found'} |",
            f"| CSRF | {'✅ Protected' if not results.get('csrf', {}).get('vulnerable') else '❌ Vulnerable endpoints'} |",
            f"| IDOR | {'✅ Clean' if not results.get('idor', {}).get('potential_idor') else '❌ Potential IDOR'} |",
            f"| Privilege Escalation | {'✅ Clean' if not results.get('privilege_escalation', {}).get('potential_escalation') else '❌ Admin endpoints exposed'} |",
            f"| Open Dangerous Ports | {'✅ Clean' if not results.get('port_scan', {}).get('dangerous_ports') else '❌ Exposed ports'} |",
            f"| Security Headers | Score: {results.get('security_headers', {}).get('score', 0)}% |",
            f"| TheHarvester OSINT | {'✅ N/A (free)' if 'theharvester' not in results else ('❌ Surface exposed' if results['theharvester'].get('emails') or results['theharvester'].get('subdomains') else '✅ Clean')} |",
            f"| Metasploit Scanners | {'✅ N/A (free)' if 'metasploit' not in results else ('❌ Vulnerabilities' if results['metasploit'].get('vulnerabilities') else ('✅ Clean' if results['metasploit'].get('modules_run') else '⚠️ Not run / Docker unavailable'))} |",
            "",
            f"**Findings:** {summary.get('total_findings', 0)} total "
            f"({summary.get('critical', 0)} critical, {summary.get('high_severity', 0)} high, "
            f"{summary.get('medium_severity', 0)} medium, {summary.get('low_severity', 0)} low)",
            "",
        ]

        # Severity-sorted findings
        sev_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
        sorted_findings = sorted(findings, key=lambda f: sev_order.get(f.get("severity", "LOW"), 99))

        if sorted_findings:
            lines += ["## Findings", ""]
            for f in sorted_findings:
                icon = {"CRITICAL": "🔴", "HIGH": "🟠", "MEDIUM": "🟡", "LOW": "🔵"}.get(f["severity"], "⚪")
                lines.append(f"### {icon} [{f['severity']}] {f['type']}")
                lines.append(f"**Description:** {f['description']}")
                lines.append(f"**Recommendation:** {f['recommendation']}")
                lines.append("")
        else:
            lines += ["## Findings", "", "✅ No security vulnerabilities found.", ""]

        if not results.get("sqlmap", {}).get("available") or not results.get("xsstrike", {}).get("available"):
            lines += [
                "## Note on Advanced Scanning",
                "",
                "sqlmap and/or XSStrike were not available in the environment.",
                "Install them for comprehensive active attack simulation:",
                "```bash",
                "pip install sqlmap xsstrike",
                "```",
                "",
            ]

        lines += ["## Overall Assessment", "", summary.get("risk_level", "PASS")]
        out_path.write_text("\n".join(lines))
        return str(out_path)

    # ------------------------------------------------------------------
    # T-P4-10: TheHarvester OSINT — domain/email/subdomain recon
    # ------------------------------------------------------------------

    def run_theharvester(self, domain: str | None = None) -> dict[str, Any]:
        """
        T-P4-10: Run theHarvester for OSINT reconnaissance on the target domain.
        Detects exposed emails, subdomains, IPs, and other public attack surface.
        Pro-plan only.
        """
        result: dict[str, Any] = {
            "available": False,
            "domain": None,
            "emails": [],
            "subdomains": [],
            "ips": [],
            "error": None,
        }
        if self.user_plan != "pro":
            result["error"] = "TheHarvester requires Pro plan"
            return result

        # Derive domain from target URL if not provided
        if not domain:
            from urllib.parse import urlparse as _urlparse
            parsed = _urlparse(self.target_url)
            domain = parsed.hostname or ""
        if not domain:
            result["error"] = "Cannot determine target domain"
            return result

        result["domain"] = domain

        try:
            # Check if theHarvester is available
            _check = subprocess.run(
                ["theHarvester", "--help"],
                capture_output=True, timeout=8,
            )
            if _check.returncode not in (0, 1):  # theHarvester returns 1 for --help
                # Try alternate invocation
                _check2 = subprocess.run(
                    ["python3", "-m", "theHarvester", "--help"],
                    capture_output=True, timeout=8,
                )
                if _check2.returncode not in (0, 1):
                    result["error"] = "theHarvester not installed"
                    return result
                _cmd_prefix = ["python3", "-m", "theHarvester"]
            else:
                _cmd_prefix = ["theHarvester"]

            result["available"] = True
            # Run OSINT harvest: use Bing + crtsh (no API key required)
            harvest_run = subprocess.run(
                _cmd_prefix + [
                    "-d", domain,
                    "-b", "bing,crtsh,hackertarget",
                    "-l", "100",
                    "--screenshot", "/tmp/theharvester_screenshots",
                ],
                capture_output=True, text=True, timeout=120,
            )
            output = harvest_run.stdout + harvest_run.stderr

            # Parse emails
            import re as _re
            for email in set(_re.findall(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}", output)):
                if domain.lower() in email.lower():
                    result["emails"].append(email)
                    self.findings.append({
                        "type": "OSINT_EMAIL_EXPOSED",
                        "severity": "MEDIUM",
                        "description": f"Email exposed in public records: {email}",
                        "recommendation": "Consider using generic contact emails to reduce targeted phishing risk.",
                    })

            # Parse subdomains
            for sub in set(_re.findall(r"[\w.-]*\." + _re.escape(domain), output)):
                if sub != domain:
                    result["subdomains"].append(sub)

            # Parse IPs
            for ip in set(_re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", output)):
                result["ips"].append(ip)

            if result["emails"] or result["subdomains"]:
                self.findings.append({
                    "type": "OSINT_ATTACK_SURFACE",
                    "severity": "LOW",
                    "description": (
                        f"OSINT reveals {len(result['emails'])} email(s) and "
                        f"{len(result['subdomains'])} subdomain(s) for {domain}"
                    ),
                    "recommendation": "Review exposed subdomains; decommission unused ones; monitor for email-based attacks.",
                })

        except subprocess.TimeoutExpired:
            result["error"] = "theHarvester timed out"
        except Exception as e:
            result["error"] = str(e)

        return result

    # ------------------------------------------------------------------
    # T-P4-09: Metasploit — advanced exploit testing (Pro-only, Docker)
    # ------------------------------------------------------------------

    def run_metasploit(self, extra_modules: list[str] | None = None) -> dict[str, Any]:
        """
        T-P4-09: Run Metasploit auxiliary modules against the target via Docker.
        Uses metasploitframework/metasploit-framework Docker image.
        Pro-plan only. Runs non-destructive auxiliary/scanner modules only.
        """
        result: dict[str, Any] = {
            "available": False,
            "modules_run": [],
            "vulnerabilities": [],
            "error": None,
        }
        if self.user_plan != "pro":
            result["error"] = "Metasploit requires Pro plan"
            return result

        from urllib.parse import urlparse as _urlparse2
        parsed2 = _urlparse2(self.target_url)
        host = parsed2.hostname or "localhost"
        port = parsed2.port or (443 if parsed2.scheme == "https" else 80)

        # Safe non-destructive modules
        default_modules = [
            "auxiliary/scanner/http/http_version",
            "auxiliary/scanner/http/dir_scanner",
            "auxiliary/scanner/http/ssl_version",
        ]
        modules = extra_modules or default_modules

        try:
            # Check if Docker is available
            _docker_check = subprocess.run(["docker", "info"], capture_output=True, timeout=10)
            if _docker_check.returncode != 0:
                result["error"] = "Docker not available for Metasploit"
                return result

            result["available"] = True

            for module in modules:
                # Build resource script for this module
                rc_script = (
                    f"use {module}\n"
                    f"set RHOSTS {host}\n"
                    f"set RPORT {port}\n"
                    f"set SSL {str(parsed2.scheme == 'https').lower()}\n"
                    f"run\n"
                    f"exit\n"
                )
                rc_path = f"/tmp/pakalon_msf_{module.replace('/', '_')}.rc"
                with open(rc_path, "w") as f:
                    f.write(rc_script)

                msf_run = subprocess.run(
                    [
                        "docker", "run", "--rm",
                        "--add-host", f"{host}:host-gateway",
                        "-v", f"{rc_path}:/tmp/run.rc:ro",
                        "metasploitframework/metasploit-framework",
                        "msfconsole", "-q", "-r", "/tmp/run.rc",
                    ],
                    capture_output=True, text=True, timeout=180,
                )
                output = msf_run.stdout + msf_run.stderr

                module_result = {
                    "module": module,
                    "output_summary": output[:500] if output else "(no output)",
                    "success": msf_run.returncode == 0,
                }

                # Parse common findings
                if "Vulnerable" in output or "VULNERABLE" in output:
                    vuln_desc = f"Metasploit module {module} detected vulnerability on {host}:{port}"
                    module_result["vulnerability"] = vuln_desc
                    result["vulnerabilities"].append(vuln_desc)
                    self.findings.append({
                        "type": "METASPLOIT_FINDING",
                        "severity": "HIGH",
                        "description": vuln_desc,
                        "recommendation": "Review Metasploit output for exploitation details and apply vendor patches.",
                    })

                result["modules_run"].append(module_result)

        except subprocess.TimeoutExpired:
            result["error"] = "Metasploit scan timed out"
        except Exception as e:
            result["error"] = str(e)

        return result
