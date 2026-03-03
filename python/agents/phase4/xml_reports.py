"""
xml_reports.py — Phase 4 XmlReportGenerator: whitebox + blackbox XML/HTML security reports.
T116: JUnit-compatible XML output + human-friendly HTML.
Includes OWASP Top-10 category mapping and CWE cross-reference metadata.
"""
from __future__ import annotations

import html
import json
import pathlib
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any


# ---------------------------------------------------------------------------
# OWASP Top 10 2021 mapping — maps common rule name fragments to OWASP IDs
# ---------------------------------------------------------------------------

_OWASP_MAP: dict[str, str] = {
    # A01 - Broken Access Control
    "access.control": "A01:2021",
    "path.traversal": "A01:2021",
    "directory.traversal": "A01:2021",
    "idor": "A01:2021",
    "insecure.direct": "A01:2021",
    # A02 - Cryptographic Failures
    "crypto": "A02:2021",
    "tls": "A02:2021",
    "ssl": "A02:2021",
    "hardcoded.password": "A02:2021",
    "hardcoded.secret": "A02:2021",
    "weak.cipher": "A02:2021",
    "md5": "A02:2021",
    "sha1": "A02:2021",
    # A03 - Injection
    "sql.injection": "A03:2021",
    "sqli": "A03:2021",
    "xss": "A03:2021",
    "command.injection": "A03:2021",
    "os.injection": "A03:2021",
    "injection": "A03:2021",
    "template.injection": "A03:2021",
    # A04 - Insecure Design
    "csrf": "A04:2021",
    "ssrf": "A04:2021",
    # A05 - Security Misconfiguration
    "debug.mode": "A05:2021",
    "stack.trace": "A05:2021",
    "default.credentials": "A05:2021",
    "open.redirect": "A05:2021",
    # A06 - Vulnerable Components
    "outdated": "A06:2021",
    "vulnerable.dependency": "A06:2021",
    # A07 - Auth Failures
    "weak.password": "A07:2021",
    "jwt": "A07:2021",
    "session.fixation": "A07:2021",
    "brute.force": "A07:2021",
    # A08 - Data Integrity Failures
    "deserialization": "A08:2021",
    "unsafe.deserialization": "A08:2021",
    "pickle": "A08:2021",
    # A09 - Logging Failures
    "logging": "A09:2021",
    "log.injection": "A09:2021",
    # A10 - SSRF
    "request.forgery": "A10:2021",
    "ssrf": "A10:2021",
}

# CWE IDs for common rule patterns
_CWE_MAP: dict[str, str] = {
    "sql": "CWE-89",
    "xss": "CWE-79",
    "command.injection": "CWE-78",
    "os.injection": "CWE-78",
    "path.traversal": "CWE-22",
    "hardcoded.password": "CWE-259",
    "hardcoded.secret": "CWE-798",
    "crypto": "CWE-326",
    "md5": "CWE-327",
    "sha1": "CWE-327",
    "weak.cipher": "CWE-327",
    "buffer.overflow": "CWE-120",
    "use.after.free": "CWE-416",
    "null.pointer": "CWE-476",
    "csrf": "CWE-352",
    "ssrf": "CWE-918",
    "deserialization": "CWE-502",
    "pickle": "CWE-502",
    "open.redirect": "CWE-601",
    "log.injection": "CWE-117",
}


def _detect_owasp(rule: str, message: str) -> str | None:
    """Return the most specific OWASP category for this finding."""
    combined = (rule + " " + message).lower().replace("-", ".").replace("_", ".")
    for pattern, owasp in _OWASP_MAP.items():
        if pattern in combined:
            return owasp
    return None


def _detect_cwe(rule: str, message: str) -> str | None:
    """Return the most likely CWE ID for this finding."""
    combined = (rule + " " + message).lower().replace("-", ".").replace("_", ".")
    for pattern, cwe in _CWE_MAP.items():
        if pattern in combined:
            return cwe
    return None


def _add_properties(tc: ET.Element, finding: dict[str, Any]) -> None:
    """Add a <properties> block to the testcase with OWASP, CWE, and tool metadata."""
    rule = str(finding.get("rule", ""))
    message = str(finding.get("message", finding.get("description", "")))
    tool = str(finding.get("_tool", ""))
    severity = str(finding.get("severity", finding.get("risk", "INFO")))
    fix = str(finding.get("fix", finding.get("solution", finding.get("remediation", ""))))

    props: dict[str, str] = {
        "tool": tool,
        "severity": severity,
    }

    owasp = _detect_owasp(rule, message)
    if owasp:
        props["owasp"] = owasp

    cwe = _detect_cwe(rule, message)
    if cwe:
        props["cwe"] = cwe

    # Extra metadata from DAST tools
    if finding.get("url"):
        props["url"] = str(finding["url"])
    if finding.get("evidence"):
        props["evidence"] = str(finding["evidence"])[:200]
    if finding.get("reference"):
        props["reference"] = str(finding["reference"])[:200]

    if not props:
        return

    properties_el = ET.SubElement(tc, "properties")
    for name, value in props.items():
        prop = ET.SubElement(properties_el, "property")
        prop.set("name", name)
        prop.set("value", value)

    # Fix/remediation guidance in <system-out>
    if fix:
        sys_out = ET.SubElement(tc, "system-out")
        sys_out.text = f"Remediation: {fix}"


def _add_assertions(tc: ET.Element, finding: dict[str, Any]) -> None:
    """
    Add <assertion> child elements to a <testcase>.
    Each assertion represents a distinct security property that was checked.
    Format: <assertion name="..." expected="..." actual="..." result="pass|fail" />
    """
    severity = str(finding.get("severity", finding.get("risk", "INFO"))).upper()
    rule = str(finding.get("rule", finding.get("name", finding.get("alert", "finding"))))
    message = str(finding.get("message", finding.get("description", finding.get("alert", ""))))
    fix = str(finding.get("fix", finding.get("solution", finding.get("remediation", ""))))
    path = str(finding.get("path", finding.get("url", finding.get("file", ""))))
    line = str(finding.get("line", finding.get("lineno", "")))
    evidence = str(finding.get("evidence", ""))

    passed = severity not in ("HIGH", "CRITICAL", "ERROR", "MEDIUM", "WARNING")

    # --- Assertion 1: Finding detected ---
    a1 = ET.SubElement(tc, "assertion")
    a1.set("name", f"security_check.{rule[:80]}")
    a1.set("expected", "No vulnerabilities matching this rule")
    a1.set("actual", message[:200] if message else f"{rule} detected")
    a1.set("result", "pass" if passed else "fail")
    if path:
        a1.set("location", f"{path}:{line}" if line else path)

    # --- Assertion 2: Evidence / reproduction detail ---
    if evidence:
        a2 = ET.SubElement(tc, "assertion")
        a2.set("name", f"evidence.{rule[:60]}")
        a2.set("expected", "No exploitable evidence")
        a2.set("actual", evidence[:200])
        a2.set("result", "fail")

    # --- Assertion 3: OWASP category coverage ---
    owasp = _detect_owasp(rule, message)
    if owasp:
        a3 = ET.SubElement(tc, "assertion")
        a3.set("name", f"owasp_category.{owasp}")
        a3.set("expected", f"Application is free from {owasp} vulnerabilities")
        a3.set("actual", f"{owasp} weakness detected via {finding.get('_tool', 'scanner')}")
        a3.set("result", "pass" if passed else "fail")

    # --- Assertion 4: Remediation acknowledgement ---
    if fix:
        a4 = ET.SubElement(tc, "assertion")
        a4.set("name", f"remediation_available.{rule[:60]}")
        a4.set("expected", "Remediation applied")
        a4.set("actual", f"Pending: {fix[:150]}")
        a4.set("result", "pending")


def _build_per_tool_testsuites(
    all_findings_by_tool: dict[str, list[dict]],
    suite_name_prefix: str,
    root: ET.Element,
) -> None:
    """
    Populate *root* (<testsuites>) with per-tool <testsuite> children,
    each containing <testcase> elements with <assertion> depth.
    """
    for tool_name, findings in all_findings_by_tool.items():
        ts = ET.SubElement(root, "testsuite")
        ts.set("name", f"{suite_name_prefix}.{tool_name}")
        ts.set("tests", str(len(findings)))
        failures = sum(
            1 for f in findings
            if str(f.get("severity", f.get("risk", ""))).upper() in ("HIGH", "CRITICAL", "ERROR")
        )
        ts.set("failures", str(failures))
        ts.set("errors", "0")
        ts.set("timestamp", datetime.now(timezone.utc).isoformat())

        for f in findings:
            tc = ET.SubElement(ts, "testcase")
            rule = f.get("rule", f.get("name", f.get("alert", "finding")))
            url_or_path = f.get("url", f.get("path", f.get("file", "")))
            tc.set("name", str(rule)[:120])
            tc.set("classname", f"{tool_name}.{str(url_or_path).replace('/', '.').replace('://', '.')[:80]}")
            tc.set("file", str(url_or_path))
            tc.set("line", str(f.get("line", f.get("lineno", 0))))
            tc.set("time", "0")

            severity = str(f.get("severity", f.get("risk", "INFO"))).upper()
            msg = f.get("message", f.get("description", f.get("alert", "")))
            if severity in ("HIGH", "CRITICAL", "ERROR"):
                failure = ET.SubElement(tc, "failure")
                failure.set("message", str(msg)[:300])
                failure.set("type", severity)
                failure.text = str(msg)
            elif severity in ("MEDIUM", "WARNING"):
                skipped = ET.SubElement(tc, "skipped")
                skipped.set("message", f"{severity}: {str(msg)[:200]}")

            # Full assertion depth
            _add_assertions(tc, f)

            # OWASP/CWE properties
            _add_properties(tc, f)


class XmlReportGenerator:
    """
    Generates JUnit-compatible XML and HTML security reports from SAST/DAST results.
    XML output uses the <testsuites> / <testsuite> / <testcase> / <assertion> hierarchy
    for full JUnit 5 depth. Each <testcase> includes <assertion> elements, <properties>
    with OWASP/CWE metadata, and optional <system-out> remediation guidance.
    """

    def __init__(self, output_dir: str = "."):
        self.output_dir = pathlib.Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------

    def generate_whitebox(self, sast_results: dict, filename: str = "whitebox_testing.xml") -> str:
        """
        Generate JUnit-compatible XML from SAST (whitebox) results.
        Uses <testsuites> root with per-tool <testsuite> groups and
        per-finding <testcase> elements containing <assertion> depth.
        """
        findings_by_tool: dict[str, list[dict]] = {}
        for tool, data in sast_results.items():
            if tool == "summary":
                continue
            findings = [dict(f, **{"_tool": tool}) for f in data.get("findings", []) + data.get("alerts", [])]
            if findings:
                findings_by_tool[tool] = findings

        total = sum(len(v) for v in findings_by_tool.values())
        high = sast_results.get("summary", {}).get("high_severity", 0)

        root = ET.Element("testsuites")
        root.set("name", "SAST Whitebox Security Scan")
        root.set("tests", str(total))
        root.set("failures", str(high))
        root.set("errors", "0")
        root.set("timestamp", datetime.now(timezone.utc).isoformat())

        _build_per_tool_testsuites(findings_by_tool, "sast", root)

        tree = ET.ElementTree(root)
        ET.indent(tree)
        out_path = self.output_dir / filename
        tree.write(str(out_path), encoding="unicode", xml_declaration=True)
        return str(out_path)

    def generate_blackbox(self, dast_results: dict, filename: str = "blackbox_testing.xml") -> str:
        """
        Generate JUnit-compatible XML from DAST (blackbox) results.
        Uses <testsuites> root with per-tool <testsuite> groups and
        per-finding <testcase> elements containing <assertion> depth.
        """
        findings_by_tool: dict[str, list[dict]] = {}
        for tool, data in dast_results.items():
            if tool == "summary":
                continue
            findings = [dict(f, **{"_tool": tool}) for f in data.get("findings", []) + data.get("alerts", [])]
            if findings:
                findings_by_tool[tool] = findings

        hdr = dast_results.get("security_headers", {})
        header_findings = [
            {
                "_tool": "security_headers",
                "rule": "missing_header",
                "name": f"Missing: {h}",
                "message": f"Missing security header: {h}",
                "severity": "MEDIUM",
                "fix": f"Add the '{h}' HTTP response header. See MDN Web Docs for correct values.",
            }
            for h in hdr.get("missing", [])
        ]
        if header_findings:
            findings_by_tool["security_headers"] = header_findings

        total = sum(len(v) for v in findings_by_tool.values())
        high = dast_results.get("summary", {}).get("high_severity", 0)

        root = ET.Element("testsuites")
        root.set("name", "DAST Blackbox Security Scan")
        root.set("tests", str(total))
        root.set("failures", str(high))
        root.set("errors", "0")
        root.set("timestamp", datetime.now(timezone.utc).isoformat())

        _build_per_tool_testsuites(findings_by_tool, "dast", root)

        tree = ET.ElementTree(root)
        ET.indent(tree)
        out_path = self.output_dir / filename
        tree.write(str(out_path), encoding="unicode", xml_declaration=True)
        return str(out_path)

    def generate_html(
        self,
        sast_results: dict,
        dast_results: dict,
        filename: str = "security-report.html",
    ) -> str:
        """Generate a human-friendly HTML security report with OWASP coverage grid."""
        sast_summary = sast_results.get("summary", {})
        dast_summary = dast_results.get("summary", {})
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        overall_pass = sast_summary.get("passed", True) and dast_summary.get("passed", True)
        badge = "&#10003; PASSED" if overall_pass else "&#10007; FAILED"
        badge_color = "#16a34a" if overall_pass else "#dc2626"

        # Collect all findings with metadata
        all_findings: list[dict] = []
        for tool, data in {**sast_results, **dast_results}.items():
            if tool == "summary":
                continue
            for f in (data.get("findings", []) + data.get("alerts", []))[:15]:
                f["_tool"] = tool
                all_findings.append(f)
        # Security headers
        for missing in dast_results.get("security_headers", {}).get("missing", []):
            all_findings.append({
                "_tool": "security_headers",
                "rule": "missing_header",
                "name": f"Missing: {missing}",
                "message": f"Missing security header: {missing}",
                "severity": "MEDIUM",
                "fix": f"Add the '{missing}' HTTP response header.",
            })

        rows = ""
        for f in all_findings:
            severity = f.get("severity", f.get("risk", "INFO"))
            sev_color = "#dc2626" if str(severity).upper() in ("HIGH", "CRITICAL") else "#d97706" if str(severity).upper() in ("MEDIUM", "WARNING") else "#6b7280"
            rule = f.get("rule", f.get("name", f.get("alert", "—")))
            owasp = _detect_owasp(rule, f.get("message", "")) or "—"
            cwe = _detect_cwe(rule, f.get("message", "")) or "—"
            fix = f.get("fix", f.get("solution", f.get("remediation", "")))[:80]
            rows += f"""<tr>
  <td>{html.escape(str(f.get('_tool', '')))}</td>
  <td><code>{html.escape(rule[:60])}</code></td>
  <td style="font-size:0.8rem;color:#6b7280">{html.escape(f.get('path', f.get('url', '—'))[:60])}</td>
  <td style="color:{sev_color};font-weight:600">{html.escape(str(severity))}</td>
  <td style="color:#1d4ed8;font-size:0.8rem">{html.escape(owasp)}</td>
  <td style="color:#7c3aed;font-size:0.8rem">{html.escape(cwe)}</td>
  <td>{html.escape(f.get('message', f.get('description', f.get('alert', '')))[:80])}</td>
  <td style="font-size:0.8rem;color:#059669">{html.escape(fix)}</td>
</tr>"""

        # OWASP coverage grid
        owasp_categories = [
            ("A01:2021", "Broken Access Control"),
            ("A02:2021", "Cryptographic Failures"),
            ("A03:2021", "Injection"),
            ("A04:2021", "Insecure Design"),
            ("A05:2021", "Security Misconfiguration"),
            ("A06:2021", "Vulnerable Components"),
            ("A07:2021", "Identification Failures"),
            ("A08:2021", "Data Integrity Failures"),
            ("A09:2021", "Logging Failures"),
            ("A10:2021", "SSRF"),
        ]
        found_owasp: set[str] = set()
        for f in all_findings:
            rule = f.get("rule", f.get("name", ""))
            msg = f.get("message", f.get("description", ""))
            o = _detect_owasp(rule, msg)
            if o:
                found_owasp.add(o)

        owasp_cells = ""
        for oid, oname in owasp_categories:
            has_finding = oid in found_owasp
            cell_color = "#fef2f2" if has_finding else "#f0fdf4"
            dot_color = "#dc2626" if has_finding else "#16a34a"
            dot = "&#9679;" if has_finding else "&#10003;"
            owasp_cells += f"""<div style="background:{cell_color};border-radius:6px;padding:0.75rem;border:1px solid {'#fecaca' if has_finding else '#bbf7d0'}">
  <span style="color:{dot_color};font-weight:700">{dot}</span>
  <span style="font-size:0.75rem;font-weight:600;color:#374151">{oid}</span><br>
  <span style="font-size:0.7rem;color:#6b7280">{oname}</span>
</div>"""

        content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><title>Pakalon Security Report</title>
<style>
  body {{font-family:system-ui;max-width:1300px;margin:0 auto;padding:2rem;background:#f9fafb;color:#111827;}}
  h1 {{margin-bottom:0.25rem;font-size:1.75rem;}} h2 {{margin-top:2rem;font-size:1.1rem;color:#374151;}}
  .badge {{font-size:1.25rem;color:{badge_color};font-weight:700;}}
  table {{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);}}
  th {{background:#1f2937;color:#fff;padding:0.625rem 0.75rem;text-align:left;font-size:0.8rem;}}
  td {{padding:0.5rem 0.75rem;border-bottom:1px solid #e5e7eb;font-size:0.8rem;vertical-align:top;}}
  tr:last-child td {{border:none;}} tr:hover td {{background:#f9fafb;}}
  .summary {{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin:1.5rem 0;}}
  .card {{background:#fff;border-radius:8px;padding:1rem 1.5rem;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1);}}
  .card .num {{font-size:1.75rem;font-weight:700;}} .card .label {{color:#6b7280;font-size:0.8rem;margin-top:0.25rem;}}
  .owasp-grid {{display:grid;grid-template-columns:repeat(5,1fr);gap:0.75rem;margin:1rem 0;}}
  code {{background:#f3f4f6;padding:0.1rem 0.3rem;border-radius:3px;font-size:0.75rem;}}
</style>
</head>
<body>
<h1>&#128272; Pakalon Security Report</h1>
<div class="badge">{badge}</div>
<p style="color:#6b7280;margin-top:0.25rem">{ts}</p>

<div class="summary">
  <div class="card"><div class="num">{sast_summary.get('total_findings', 0)}</div><div class="label">SAST Findings</div></div>
  <div class="card"><div class="num">{dast_summary.get('total_findings', 0)}</div><div class="label">DAST Findings</div></div>
  <div class="card"><div class="num" style="color:#dc2626">{sast_summary.get('high_severity', 0) + dast_summary.get('high_severity', 0)}</div><div class="label">High Severity</div></div>
  <div class="card"><div class="num" style="color:{badge_color}">{badge}</div><div class="label">Overall Result</div></div>
</div>

<h2>OWASP Top 10 Coverage</h2>
<div class="owasp-grid">{owasp_cells}</div>

<h2>Findings</h2>
<table>
  <thead><tr><th>Tool</th><th>Rule</th><th>Path / URL</th><th>Severity</th><th>OWASP</th><th>CWE</th><th>Message</th><th>Remediation</th></tr></thead>
  <tbody>{rows if rows else '<tr><td colspan="8" style="text-align:center;padding:2rem;color:#6b7280">No findings — all checks passed</td></tr>'}</tbody>
</table>
</body></html>"""

        out_path = self.output_dir / filename
        out_path.write_text(content, encoding="utf-8")
        return str(out_path)
