"""
graph.py — Phase 4 LangGraph StateGraph: Security QA Agent.
7 sub-agents running in sequence:
  SA1: hoppscotch_api_test — Hoppscotch + httpx API security testing (writes subagent-1.md)
  SA2: sast_scan — static analysis (writes subagent-2.md)
  SA3: dast_scan — dynamic analysis + Vercel browser tests (writes subagent-3.md)
  SA4: requirement_check — verify implementations (writes subagent-4.md)
  SA5: cicd_testing — CI/CD pipeline security & best practices (writes subagent-5.md)
  SA6: cyber_security — active attack simulation (writes subagent-6.md)
  SA7: generate_reports_and_fixes — XML/HTML reports + LLM fix suggestions + phase-4.md
"""
from __future__ import annotations

import json
import os
import pathlib
from typing import Any, TypedDict

try:
    from langgraph.graph import StateGraph, END  # type: ignore
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

from .hoppscotch_tester import HoppscotchTester
from .sast import SASTRunner
from .dast import DASTRunner
from .xml_reports import XmlReportGenerator
from .requirement_check import RequirementChecker
from .cicd_tester import CICDTester
from .cyber_security import CyberSecurityTester
from ..shared.paths import get_phase_dir
from ..shared.decision_registry import record_decision


class Phase4State(TypedDict, total=False):
    project_dir: str
    user_id: str
    user_plan: str  # "free" | "pro" — T-BACK-11 pro feature gating
    is_yolo: bool
    send_sse: Any
    target_url: str
    hoppscotch_results: dict
    sast_results: dict
    dast_results: dict
    requirement_results: dict
    cicd_results: dict
    cyber_results: dict
    report_paths: list[str]
    fix_suggestions: list[dict]
    outputs_saved: list[str]
    needs_phase3_retry: bool
    retry_count: int  # Track number of Phase 3 retries (max 3)
    phase3_findings: list[dict]  # Findings to send back to Phase 3
    phase3_validation_results: dict  # T-P4-07: Phase 3 agent_browser + tdd_loop validation data

    context_budget: dict | None  # T103: optional ContextBudget.get_all() dict for per-phase max_tokens caps
    _mem0_context: str  # T-A03: Phase 1 context from Mem0


RETRY_SCORE_THRESHOLD = 97


def _canonical_severity(value: Any) -> str:
    raw = str(value or "LOW").upper()
    if raw in {"CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"}:
        return raw
    if raw in {"ERROR"}:
        return "HIGH"
    if raw in {"WARN", "WARNING"}:
        return "MEDIUM"
    return "LOW"


def _coerce_line_number(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except Exception:
        return None


def _normalize_finding(tool_name: str, finding: Any) -> dict[str, Any]:
    if not isinstance(finding, dict):
        return {
            "tool": tool_name,
            "severity": "LOW",
            "rule": tool_name.upper(),
            "location": "n/a",
            "file_path": None,
            "line_number": None,
            "cause": str(finding),
            "solution": "Review and remediate this issue.",
            "confidence": "",
        }

    start = finding.get("start") if isinstance(finding.get("start"), dict) else {}
    file_path = (
        finding.get("file_path")
        or finding.get("path")
        or finding.get("file")
        or finding.get("filename")
        or finding.get("url")
        or finding.get("host")
    )
    line_number = (
        _coerce_line_number(finding.get("line_number"))
        or _coerce_line_number(finding.get("line"))
        or _coerce_line_number(start.get("line"))
    )
    location = str(file_path or "n/a")
    if line_number is not None:
        location = f"{location}:{line_number}"

    return {
        "tool": tool_name,
        "severity": _canonical_severity(finding.get("severity") or finding.get("risk") or finding.get("level")),
        "rule": (
            finding.get("rule")
            or finding.get("rule_id")
            or finding.get("check_id")
            or finding.get("type")
            or finding.get("name")
            or finding.get("id")
            or tool_name.upper()
        ),
        "location": location,
        "file_path": file_path,
        "line_number": line_number,
        "cause": (
            finding.get("description")
            or finding.get("message")
            or finding.get("detail")
            or finding.get("issue")
            or finding.get("evidence")
            or str(finding)
        ),
        "solution": (
            finding.get("recommendation")
            or finding.get("fix")
            or finding.get("suggestion")
            or finding.get("solution")
            or "Review and remediate this issue."
        ),
        "confidence": finding.get("confidence") or finding.get("confidencedesc") or "",
    }


def _count_severities(findings: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
    for finding in findings:
        severity = _canonical_severity(finding.get("severity"))
        counts[severity.lower()] += 1
    return counts


def _score_from_counts(counts: dict[str, int], fallback: int | float = 100) -> int:
    penalty = (
        counts.get("critical", 0) * 25
        + counts.get("high", 0) * 10
        + counts.get("medium", 0) * 4
        + counts.get("low", 0) * 1
    )
    return max(0, int(round(fallback - penalty)))


def _extract_tool_findings(tool_name: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    findings = [
        _normalize_finding(tool_name, finding)
        for finding in [
            *(payload.get("findings", []) or []),
            *(payload.get("alerts", []) or []),
        ]
    ]

    if not findings and payload.get("open_ports"):
        findings = [
            _normalize_finding(
                tool_name,
                {
                    "severity": "LOW",
                    "type": "OPEN_PORT",
                    "description": f"Port {item.get('port')}/{item.get('protocol', 'tcp')} is open ({item.get('service', 'unknown service')})",
                    "host": item.get("host") or item.get("ip") or "network",
                    "recommendation": "Close unused ports or restrict network exposure.",
                },
            )
            for item in payload.get("open_ports", [])
        ]

    if not findings and payload.get("missing_headers"):
        findings = [
            _normalize_finding(
                tool_name,
                {
                    "severity": "MEDIUM",
                    "type": "MISSING_SECURITY_HEADER",
                    "description": f"Missing security header: {header}",
                    "host": payload.get("target") or payload.get("url") or "http-response",
                    "recommendation": "Add the missing security header to harden the HTTP response.",
                },
            )
            for header in payload.get("missing_headers", [])
        ]

    return findings


def _build_tool_report(
    name: str,
    findings: list[dict[str, Any]],
    *,
    score: Any = None,
    passed: Any = None,
) -> dict[str, Any]:
    counts = _count_severities(findings)
    computed_score = _score_from_counts(counts)
    if score not in (None, ""):
        try:
            computed_score = max(0, min(100, int(round(float(score)))))
        except Exception:
            pass

    tool_passed = bool(passed) if passed is not None else computed_score >= RETRY_SCORE_THRESHOLD

    return {
        "name": name,
        "findings": findings,
        "total_findings": len(findings),
        "critical": counts["critical"],
        "high": counts["high"],
        "medium": counts["medium"],
        "low": counts["low"],
        "score": computed_score,
        "passed": tool_passed,
    }


def _build_phase4_tool_reports(state: Phase4State) -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = []

    hop = state.get("hoppscotch_results", {}) or {}
    hop_findings = [_normalize_finding("Hoppscotch API Tests", finding) for finding in hop.get("findings", [])]
    reports.append(
        _build_tool_report(
            "Hoppscotch API Tests",
            hop_findings,
            score=(hop.get("summary", {}) or {}).get("security_score"),
            passed=(hop.get("summary", {}) or {}).get("passed"),
        )
    )

    for tool_name, tool_result in (state.get("sast_results", {}) or {}).items():
        if tool_name == "summary" or not isinstance(tool_result, dict):
            continue
        findings = _extract_tool_findings(tool_name, tool_result)
        reports.append(_build_tool_report(tool_name, findings, passed=tool_result.get("passed")))

    for tool_name, tool_result in (state.get("dast_results", {}) or {}).items():
        if tool_name in {"summary", "vercel_browser"} or not isinstance(tool_result, dict):
            continue
        findings = _extract_tool_findings(tool_name, tool_result)
        reports.append(
            _build_tool_report(
                tool_name,
                findings,
                score=tool_result.get("security_score") or tool_result.get("score"),
                passed=tool_result.get("passed"),
            )
        )

    cicd = state.get("cicd_results", {}) or {}
    reports.append(
        _build_tool_report(
            "CI/CD Security",
            [_normalize_finding("CI/CD Security", finding) for finding in cicd.get("findings", [])],
            passed=(cicd.get("summary", {}) or {}).get("passed"),
        )
    )

    cyber = state.get("cyber_results", {}) or {}
    reports.append(
        _build_tool_report(
            "Cyber Security",
            [_normalize_finding("Cyber Security", finding) for finding in cyber.get("findings", [])],
            score=(cyber.get("summary", {}) or {}).get("security_score"),
            passed=(cyber.get("summary", {}) or {}).get("passed"),
        )
    )

    requirement_items = (state.get("requirement_results", {}) or {}).get("items", [])
    requirement_findings = [
        _normalize_finding(
            "Requirements",
            {
                "severity": "HIGH",
                "type": "REQUIREMENT_NOT_MET",
                "description": item.get("requirement", "Requirement not met"),
                "file_path": item.get("file_path"),
                "recommendation": "Implement the missing requirement in Phase 3 before proceeding.",
            },
        )
        for item in requirement_items
        if item.get("status") != "pass"
    ]
    req_summary = (state.get("requirement_results", {}) or {}).get("summary", {}) or {}
    reports.append(
        _build_tool_report(
            "Requirements",
            requirement_findings,
            score=round(float(req_summary.get("pass_rate", 1)) * 100),
            passed=req_summary.get("met_threshold"),
        )
    )

    return reports


def _tool_details_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"### {report['name']} — {report['score']}/100",
        "",
        f"- Status: {'✅ Pass' if report['passed'] else '❌ Needs work'}",
        f"- Findings: {report['total_findings']} (critical {report['critical']}, high {report['high']}, medium {report['medium']}, low {report['low']})",
        "",
    ]

    findings = report.get("findings", [])
    if not findings:
        lines.append("No issues found for this tool.")
        lines.append("")
        return "\n".join(lines)

    for finding in findings:
        lines.extend(
            [
                f"- **[{finding['severity']}] {finding['rule']}**",
                f"  - Location: {finding['location']}",
                f"  - Cause: {finding['cause']}",
                f"  - Suggested fix: {finding['solution']}",
                *( [f"  - Confidence: {finding['confidence']}"] if finding.get("confidence") else [] ),
                "",
            ]
        )

    return "\n".join(lines)

# ------------------------------------------------------------------
# Nodes
# ------------------------------------------------------------------

async def sa1_hoppscotch_api_test(state: Phase4State) -> Phase4State:
    """SA1: Hoppscotch + httpx API security testing."""
    sse = state.get("send_sse") or (lambda e: None)
    user_plan = state.get("user_plan", "free")
    project_dir = state.get("project_dir", ".")
    target = state.get("target_url", "http://localhost:3000")
    sse({"type": "text_delta", "content": f"🔌 SA1: Hoppscotch API security testing on {target}...\n"})
    tester = HoppscotchTester(
        target_url=target,
        project_dir=project_dir,
        user_plan=user_plan,
    )
    results = await tester.run_all(send_sse=sse)
    state["hoppscotch_results"] = results
    summary = results.get("summary", {})
    sse({
        "type": "text_delta",
        "content": (
            f"  Hoppscotch: {summary.get('total_findings', 0)} findings "
            f"({summary.get('critical', 0)} critical, {summary.get('high_severity', 0)} high) "
            f"score={summary.get('security_score', 100)}/100\n"
        ),
    })
    out_dir = get_phase_dir(project_dir, 4)
    out_dir.mkdir(parents=True, exist_ok=True)
    tester.write_subagent_md(str(out_dir), results)
    return state


async def sa2_sast_scan(state: Phase4State) -> Phase4State:
    sse = state.get("send_sse") or (lambda e: None)
    user_plan = state.get("user_plan", "free")
    project_dir = state.get("project_dir", ".")
    sse({"type": "text_delta", "content": "🔍 SA1: Running static security analysis...\n"})
    if user_plan != "pro":
        sse({"type": "text_delta", "content": "  ℹ️  Free plan: pro-only tools (Semgrep, Gitleaks) skipped.\n"})
    runner = SASTRunner(project_dir=project_dir, user_plan=user_plan)
    results = runner.run_all()
    state["sast_results"] = results
    h = results.get("summary", {}).get("high_severity", 0)
    sse({"type": "text_delta", "content": f"  SAST: {results.get('summary', {}).get('total_findings', 0)} findings ({h} high)\n"})
    # Write subagent-1.md
    out_dir = get_phase_dir(project_dir, 4)
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_sa_md(
        out_dir / "subagent-1.md",
        "SA1: Static Application Security Testing (SAST)",
        results.get("summary", {}),
        results.get("findings", []),
    )
    return state


async def sa3_dast_scan(state: Phase4State) -> Phase4State:
    sse = state.get("send_sse") or (lambda e: None)
    user_plan = state.get("user_plan", "free")
    project_dir = state.get("project_dir", ".")
    target = state.get("target_url", "http://localhost:3000")
    sse({"type": "text_delta", "content": f"🌐 SA3: Running dynamic security analysis on {target}...\n"})
    if user_plan != "pro":
        sse({"type": "text_delta", "content": "  ℹ️  Free plan: pro-only tools (OWASP ZAP, Nikto) skipped.\n"})
    runner = DASTRunner(target_url=target, project_dir=project_dir, user_plan=user_plan)
    results = runner.run_all()
    state["dast_results"] = results
    h = results.get("summary", {}).get("high_severity", 0)
    sse({"type": "text_delta", "content": f"  DAST: {results.get('summary', {}).get('total_findings', 0)} findings ({h} high)\n"})

    # T-CLI-14: Vercel Agent Browser testing integration
    sse({"type": "text_delta", "content": "🤖 SA3: Running Vercel Agent Browser tests...\n"})
    vercel_results: dict = {}
    try:
        from .vercel_browser import VercelBrowserTester
        tester = VercelBrowserTester(target_url=target, project_dir=project_dir)
        vercel_results = await tester.run_tests(send_sse=sse)
        sse({"type": "text_delta", "content": f"  Vercel Browser: {vercel_results.get('passed', 0)}/{vercel_results.get('total', 0)} tests passed\n"})
    except Exception as vb_err:
        vercel_results = {"error": str(vb_err), "passed": 0, "total": 0}
        sse({"type": "text_delta", "content": f"  Vercel Browser tests skipped: {vb_err}\n"})
    results["vercel_browser"] = vercel_results

    # Write subagent-3.md
    out_dir = get_phase_dir(project_dir, 4)
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_sa_md(
        out_dir / "subagent-3.md",
        "SA3: Dynamic Application Security Testing (DAST)",
        results.get("summary", {}),
        results.get("findings", []),
    )
    return state


async def sa4_requirement_check(state: Phase4State) -> Phase4State:
    sse = state.get("send_sse") or (lambda e: None)
    project_dir = state.get("project_dir", ".")
    sse({"type": "text_delta", "content": "📋 SA4: Checking requirement coverage...\n"})
    checker = RequirementChecker(project_dir=project_dir)
    results = checker.run_structured()
    state["requirement_results"] = results
    rate = results.get("summary", {}).get("pass_rate", 0)
    sse({"type": "text_delta", "content": f"  Coverage: {rate:.0%}\n"})

    # T-CLI-23: If coverage < 70%, flag for Phase 3 re-entry
    REQ_THRESHOLD = 0.70
    if rate < REQ_THRESHOLD:
        state["needs_phase3_retry"] = True
        sse({
            "type": "text_delta",
            "content": (
                f"  ⚠️  Coverage {rate:.0%} is below {REQ_THRESHOLD:.0%} threshold — "
                "Phase 3 will be requested to generate missing implementations.\n"
            ),
        })
    else:
        state["needs_phase3_retry"] = False

    # Write subagent-3.md
    out_dir = get_phase_dir(project_dir, 4)
    out_dir.mkdir(parents=True, exist_ok=True)
    items = results.get("items", [])
    findings = [
        {"severity": "HIGH" if it.get("status") != "pass" else "INFO",
         "type": "REQUIREMENT_NOT_MET",
         "description": it.get("requirement", ""),
         "recommendation": "Implement the missing requirement in Phase 3"}
        for it in items if it.get("status") != "pass"
    ]
    _write_sa_md(
        out_dir / "subagent-4.md",
        "SA4: Requirement Coverage Check",
        results.get("summary", {}),
        findings,
    )
    return state


async def sa5_cicd_testing(state: Phase4State) -> Phase4State:
    """SA5: CI/CD pipeline security & best practices analysis."""
    sse = state.get("send_sse") or (lambda e: None)
    project_dir = state.get("project_dir", ".")
    user_plan = state.get("user_plan", "free")
    sse({"type": "text_delta", "content": "🔧 SA5: Scanning CI/CD pipelines for security issues and best practices...\n"})
    tester = CICDTester(project_dir=project_dir, user_plan=user_plan)
    results = tester.run()
    state["cicd_results"] = results
    findings_count = len(results.get("findings", []))
    sse({"type": "text_delta", "content": f"  CI/CD: {findings_count} findings in {results.get('files_scanned', 0)} files\n"})
    out_dir = get_phase_dir(project_dir, 4)
    out_dir.mkdir(parents=True, exist_ok=True)
    tester.write_subagent_md(str(out_dir), results)
    return state


async def sa6_cyber_security(state: Phase4State) -> Phase4State:
    """SA6: Active cyber security attack simulation."""
    sse = state.get("send_sse") or (lambda e: None)
    project_dir = state.get("project_dir", ".")
    user_plan = state.get("user_plan", "free")
    target = state.get("target_url", "http://localhost:3000")
    sse({"type": "text_delta", "content": f"🛡️  SA6: Running cyber security attack simulation on {target}...\n"})
    if user_plan != "pro":
        sse({"type": "text_delta", "content": "  ℹ️  Free plan: sqlmap and XSStrike (active attack tools) not executed.\n"})
    tester = CyberSecurityTester(target_url=target, project_dir=project_dir, user_plan=user_plan)
    results = await tester.run_all()
    state["cyber_results"] = results
    summary = results.get("summary", {})
    sse({"type": "text_delta", "content": f"  Cyber: {summary.get('total_findings', 0)} findings, score {summary.get('security_score', 0)}/100\n"})
    out_dir = get_phase_dir(project_dir, 4)
    out_dir.mkdir(parents=True, exist_ok=True)
    tester.write_subagent_md(str(out_dir), results)
    return state


async def sa7_generate_reports_and_fixes(state: Phase4State) -> Phase4State:
    """SA7: Generate XML/HTML reports and LLM fix suggestions."""
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📊 SA7: Generating security reports and fix suggestions...\n"})
    project_dir = pathlib.Path(state.get("project_dir", "."))
    out_dir = get_phase_dir(project_dir, 4)
    out_dir.mkdir(parents=True, exist_ok=True)

    gen = XmlReportGenerator(output_dir=str(out_dir))
    sast = state.get("sast_results", {})
    dast = state.get("dast_results", {})

    paths = [
        gen.generate_whitebox(sast),
        gen.generate_blackbox(dast),
        gen.generate_html(sast, dast),
    ]

    # Requirement coverage report
    checker = RequirementChecker(project_dir=str(project_dir))
    req_report = checker.write_report(str(out_dir / "requirement-coverage.md"))
    paths.append(req_report)
    state["report_paths"] = paths

    # Collect high-severity findings across all agents
    high_findings: list[dict] = []
    # SA1: Hoppscotch findings
    for f in state.get("hoppscotch_results", {}).get("findings", []):
        if f.get("severity", "").upper() in ("HIGH", "CRITICAL"):
            high_findings.append({**f, "_tool": "hoppscotch"})
    for results_dict in [sast, dast]:
        for tool, data in results_dict.items():
            if tool == "summary" or not isinstance(data, dict):
                continue
            for f in data.get("findings", []) + data.get("alerts", []):
                if f.get("severity", "").upper() in ("HIGH", "CRITICAL", "ERROR"):
                    high_findings.append({**f, "_tool": tool})
    # Include cicd and cyber high findings
    for f in state.get("cicd_results", {}).get("findings", []):
        if f.get("severity", "").upper() in ("HIGH", "CRITICAL"):
            high_findings.append({**f, "_tool": "cicd"})
    for f in state.get("cyber_results", {}).get("findings", []):
        if f.get("severity", "").upper() in ("HIGH", "CRITICAL"):
            high_findings.append({**f, "_tool": "cyber"})

    suggestions: list[dict] = []
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if api_key and high_findings:
        try:
            import re as _re
            import httpx
            prompt = (
                f"Provide fix suggestions for these security findings:\n\n"
                f"{json.dumps(high_findings[:10], indent=2)}\n\n"
                "Return JSON array of {finding_rule, fix_description, code_example}."
            )
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": os.environ.get("PAKALON_MODEL", "anthropic/claude-3-5-haiku"),
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": 2000,
                    },
                )
                resp.raise_for_status()
                raw = resp.json()["choices"][0]["message"]["content"]
                m = _re.search(r"\[.*\]", raw, _re.DOTALL)
                if m:
                    suggestions = json.loads(m.group())
        except Exception:
            pass

    state["fix_suggestions"] = suggestions

    tool_reports = _build_phase4_tool_reports(state)
    overall_score = int(round(sum(report["score"] for report in tool_reports) / max(len(tool_reports), 1)))
    needs_retry = overall_score < RETRY_SCORE_THRESHOLD
    retry_count = int(state.get("retry_count", 0) or 0)

    high_findings = [
        finding
        for report in tool_reports
        for finding in report.get("findings", [])
        if finding.get("severity") in {"CRITICAL", "HIGH"}
    ]
    actionable_findings = [
        finding
        for report in tool_reports
        for finding in report.get("findings", [])
        if finding.get("severity") in {"CRITICAL", "HIGH", "MEDIUM"}
    ]

    state["qa_report"] = {
        "overall_score": overall_score,
        "threshold": RETRY_SCORE_THRESHOLD,
        "ready_for_phase5": not needs_retry,
        "tool_reports": tool_reports,
    }
    state["needs_phase3_retry"] = needs_retry
    state["phase3_findings"] = actionable_findings

    tool_summary_rows = "\n".join(
        f"| {report['name']} | {report['total_findings']} | {report['critical']} | {report['high']} | {report['medium']} | {report['low']} | {report['score']}/100 | {'✅ Pass' if report['passed'] else '❌ Retry'} |"
        for report in tool_reports
    )
    detailed_sections = "\n".join(_tool_details_markdown(report) for report in tool_reports)

    phase4_md = (
        "# Phase 4: Security & QA\n\n"
        "## Overall assessment\n\n"
        f"- Overall security confidence score: **{overall_score}/100**\n"
        f"- Phase 5 threshold: **{RETRY_SCORE_THRESHOLD}/100**\n"
        f"- Current decision: **{'✅ Ready for Phase 5' if not needs_retry else '🔄 Return to Phase 3 for fixes'}**\n"
        f"- Retry attempt: **{retry_count}**\n\n"
        "## Tool scorecard\n\n"
        "| Tool | Total | Critical | High | Medium | Low | Confidence score | Status |\n"
        "|------|-------|----------|------|--------|-----|------------------|--------|\n"
        f"{tool_summary_rows}\n\n"
        "## Detailed findings by tool\n\n"
        f"{detailed_sections}\n"
        "## Sub-agent reports\n\n"
        "- `phase-4/subagent-1.md` — Hoppscotch API security tests\n"
        "- `phase-4/subagent-2.md` — SAST results\n"
        "- `phase-4/subagent-3.md` — DAST results\n"
        "- `phase-4/subagent-4.md` — Requirement coverage\n"
        "- `phase-4/subagent-5.md` — CI/CD pipeline analysis\n"
        "- `phase-4/subagent-6.md` — Cyber security attack simulation\n\n"
        "## XML/HTML Reports\n\n"
        + "\n".join(f"- `{p}`" for p in paths) + "\n\n"
        "## Machine-readable Summary\n\n"
        "- `phase-4-security-summary.json` — Consolidated tool-by-tool scores, findings, and retry decision\n\n"
        "## Fix Suggestions\n\n"
        + (
            "\n".join(
                f"- **{suggestion.get('finding_rule', '')}**: {suggestion.get('fix_description', '')}"
                for suggestion in suggestions[:5]
            )
            or "No high-severity findings requiring fixes."
        )
        + "\n"
    )

    security_summary = {
        "status": "complete",
        "overall_score": overall_score,
        "threshold": RETRY_SCORE_THRESHOLD,
        "ready_for_phase5": not needs_retry,
        "retry_count": retry_count,
        "tool_reports": tool_reports,
        "needs_phase3_retry": needs_retry,
    }
    security_summary_path = out_dir / "phase-4-security-summary.json"
    security_summary_path.write_text(json.dumps(security_summary, indent=2))

    (out_dir / "phase-4.md").write_text(phase4_md)
    all_outputs = paths + [str(security_summary_path), str(out_dir / "phase-4.md")]
    state["outputs_saved"] = all_outputs

    # Record security findings in cross-phase decision registry
    project_dir_str = str(state.get("project_dir", "."))
    total_findings = sum(report.get("total_findings", 0) for report in tool_reports)
    record_decision(
        project_dir_str,
        phase=4,
        decision_type="security_audit",
        description=(
            f"Security scan: {total_findings} total findings — "
            f"overall_score={overall_score}/100, "
            f"ready_for_phase5={not needs_retry}"
        ),
        source_file="phase-4/phase-4.md",
        metadata={
            "tool_reports": tool_reports,
            "overall_score": overall_score,
            "threshold": RETRY_SCORE_THRESHOLD,
            "high_findings_count": len(high_findings),
        },
    )
    for finding in high_findings[:10]:  # cap at 10 to avoid bloat
        record_decision(
            project_dir_str,
            phase=4,
            decision_type="security_finding",
            description=f"{finding.get('severity', 'HIGH')}: {finding.get('description', finding.get('message', str(finding)))}",
            source_file="phase-4/phase-4-security-summary.json",
            metadata=finding if isinstance(finding, dict) else {"raw": str(finding)},
        )
    if needs_retry:
        sse({
            "type": "phase3_retry_request",
            "message": (
                f"Phase 4 score {overall_score}/100 is below the required "
                f"{RETRY_SCORE_THRESHOLD}/100 threshold."
            ),
            "findings": actionable_findings[:10],
            "retry_count": retry_count,
            "threshold": RETRY_SCORE_THRESHOLD,
        })
        sse({
            "type": "text_delta",
            "content": (
                f"\n🔄 Phase 4 score is {overall_score}/100. Returning to Phase 3 until the score reaches "
                f"{RETRY_SCORE_THRESHOLD}/100.\n"
            ),
        })
    else:
        sse({
            "type": "text_delta",
            "content": f"\n✅ Phase 4 passed with {overall_score}/100. Ready for Phase 5.\n",
        })
    
    sse({"type": "phase_complete", "phase": 4, "files": all_outputs})
    return state


# ------------------------------------------------------------------
# Helper: write generic subagent .md
# ------------------------------------------------------------------

def _write_sa_md(
    path: pathlib.Path,
    title: str,
    summary: dict,
    findings: list[dict],
) -> None:
    sev_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
    sorted_f = sorted(findings, key=lambda f: sev_order.get(f.get("severity", "LOW"), 99))
    total = summary.get("total_findings", len(findings))
    high = summary.get("high_severity", 0)
    lines = [
        f"# Phase 4 — {title}",
        "",
        f"**Total findings:** {total}  ",
        f"**High severity:** {high}  ",
        f"**Status:** {'✅ Passed' if summary.get('passed', not high) else '❌ Failed'}",
        "",
        "## Findings",
        "",
    ]
    if sorted_f:
        for f in sorted_f:
            icon = {"CRITICAL": "🔴", "HIGH": "🟠", "MEDIUM": "🟡", "LOW": "🔵", "INFO": "⚪"}.get(f.get("severity", "LOW"), "⚪")
            sev = f.get("severity", "INFO")
            ftype = f.get("type", f.get("rule", "FINDING"))
            desc = f.get("description", f.get("message", ""))
            rec = f.get("recommendation", f.get("fix", ""))
            lines.append(f"### {icon} [{sev}] {ftype}")
            if desc:
                lines.append(f"**Description:** {desc}")
            if rec:
                lines.append(f"**Recommendation:** {rec}")
            lines.append("")
    else:
        lines.append("✅ No issues found.\n")
    path.write_text("\n".join(lines))


# ------------------------------------------------------------------
# Graph assembly
# ------------------------------------------------------------------

def build_phase4_graph() -> Any:
    if not LANGGRAPH_AVAILABLE:
        return None
    graph = StateGraph(Phase4State)
    for name, fn in [
        ("sa1_hoppscotch", sa1_hoppscotch_api_test),
        ("sa2_sast", sa2_sast_scan),
        ("sa3_dast", sa3_dast_scan),
        ("sa4_req", sa4_requirement_check),
        ("sa5_cicd", sa5_cicd_testing),
        ("sa6_cyber", sa6_cyber_security),
        ("sa7_reports", sa7_generate_reports_and_fixes),
    ]:
        graph.add_node(name, fn)
    graph.set_entry_point("sa1_hoppscotch")
    graph.add_edge("sa1_hoppscotch", "sa2_sast")
    graph.add_edge("sa2_sast", "sa3_dast")
    graph.add_edge("sa3_dast", "sa4_req")
    graph.add_edge("sa4_req", "sa5_cicd")
    graph.add_edge("sa5_cicd", "sa6_cyber")
    graph.add_edge("sa6_cyber", "sa7_reports")
    graph.add_edge("sa7_reports", END)
    try:
        from ..shared.langgraph_checkpointer import build_checkpointer  # noqa: PLC0415
        _ckpt = build_checkpointer()
    except Exception:
        _ckpt = None
    return graph.compile(checkpointer=_ckpt) if _ckpt is not None else graph.compile()


def _generate_retry_patch_plan(state: Phase4State) -> dict:
    """
    Build a structured patch plan from Phase 4 findings so that the Phase 3
    retry is targeted to only the files and issues that need fixing.

    Returns a dict with:
      - issues: list of {severity, type, description, recommendation, file_path?}
      - files_to_patch: list of file paths deduced from finding metadata
      - requirements_missing: list of unmet requirement descriptions
      - summary: human-readable summary string
    """
    issues: list[dict] = []
    files_to_patch: set[str] = set()
    seen_issue_keys: set[tuple[str, str, str]] = set()

    def _append_issue(entry: dict[str, Any]) -> None:
        key = (
            str(entry.get("severity", "")),
            str(entry.get("type", "")),
            str(entry.get("description", "")),
        )
        if key in seen_issue_keys:
            return
        seen_issue_keys.add(key)
        issues.append(entry)
        if entry.get("file_path"):
            files_to_patch.add(str(entry["file_path"]))

    for finding in state.get("phase3_findings", []):
        severity = _canonical_severity(finding.get("severity"))
        if severity not in {"CRITICAL", "HIGH", "MEDIUM"}:
            continue
        _append_issue(
            {
                "severity": severity,
                "type": finding.get("rule") or finding.get("type") or "SECURITY_FINDING",
                "description": finding.get("cause") or finding.get("description") or "Security issue detected",
                "recommendation": finding.get("solution") or finding.get("recommendation") or "Fix the identified issue.",
                "file_path": finding.get("file_path") or "",
                "source": finding.get("tool") or "phase4",
                "line_number": finding.get("line_number"),
            }
        )

    if not issues:
        for report in (state.get("qa_report") or {}).get("tool_reports", []):
            for finding in report.get("findings", []):
                severity = _canonical_severity(finding.get("severity"))
                if severity not in {"CRITICAL", "HIGH", "MEDIUM"}:
                    continue
                _append_issue(
                    {
                        "severity": severity,
                        "type": finding.get("rule") or "SECURITY_FINDING",
                        "description": finding.get("cause") or "Security issue detected",
                        "recommendation": finding.get("solution") or "Fix the identified issue.",
                        "file_path": finding.get("file_path") or "",
                        "source": finding.get("tool") or report.get("name", "phase4"),
                        "line_number": finding.get("line_number"),
                    }
                )

    # Requirement check → unmet requirements indicate missing implementations
    req = state.get("requirement_results", {})
    requirements_missing: list[str] = []
    for item in req.get("items", []):
        if item.get("status") == "pass":
            continue
        desc = item.get("requirement", "")
        requirements_missing.append(desc)
        _append_issue({
            "severity": "HIGH",
            "type": "REQUIREMENT_NOT_MET",
            "description": desc,
            "recommendation": "Implement the missing feature/behaviour described",
            "file_path": item.get("file_path", ""),
            "source": "requirements",
        })

    # T-P4-07: Include Phase 3 agent_browser + tdd_loop findings for targeted retry guidance
    p3_val = state.get("phase3_validation_results", {})
    ab_findings = p3_val.get("agent_browser", {})
    tdd_findings = p3_val.get("tdd_loop", {})

    # Console errors captured by AgentBrowser in Phase 3 SA4
    for err in (ab_findings.get("console_errors") or []):
        _append_issue({
            "severity": "MEDIUM",
            "type": "BROWSER_CONSOLE_ERROR",
            "description": str(err),
            "recommendation": "Fix the JavaScript/runtime error detected during browser validation",
            "file_path": "",
            "source": "agent_browser",
        })

    # Visual diff regression beyond 15% from wireframe baseline
    visual_diff_pct = float(ab_findings.get("diff_pct", 0) or 0)
    if visual_diff_pct > 0.15:
        _append_issue({
            "severity": "HIGH",
            "type": "VISUAL_DIFF_REGRESSION",
            "description": f"Visual diff {visual_diff_pct:.1%} vs Phase 2 wireframe baseline exceeds 15% threshold",
            "recommendation": "Align component layout and styling with Phase 2 wireframe design tokens",
            "file_path": "",
            "source": "agent_browser",
        })

    # TDD loop iteration errors captured in Phase 3
    for tdd_iter in (tdd_findings.get("iterations") or []):
        for err in (tdd_iter.get("console_errors") or []):
            _append_issue({
                "severity": "MEDIUM",
                "type": "TDD_ITERATION_ERROR",
                "description": str(err),
                "recommendation": "Fix the error found during Phase 3 TDD iteration",
                "file_path": "",
                "source": "tdd_loop",
            })

    summary_parts = [f"Phase 4 retry patch plan: {len(issues)} issue(s) to fix"]
    if files_to_patch:
        summary_parts.append(f"Files affected: {', '.join(sorted(files_to_patch)[:10])}")
    if requirements_missing:
        summary_parts.append(f"Missing requirements ({len(requirements_missing)}): " + "; ".join(requirements_missing[:5]))

    return {
        "issues": issues,
        "files_to_patch": sorted(files_to_patch),
        "requirements_missing": requirements_missing,
        "summary": " | ".join(summary_parts),
        "retry_count": state.get("retry_count", 0),
        # T-P4-07: Pass through raw Phase 3 browser/TDD context for Phase 3 to use as guidance
        "agent_browser_findings": ab_findings,
        "tdd_loop_findings": tdd_findings,
    }


async def run_phase4(
    project_dir: str,
    target_url: str = "http://localhost:3000",
    user_id: str = "anonymous",
    user_plan: str = "free",
    is_yolo: bool = False,
    send_sse: Any = None,
    input_queue: Any = None,
    context_budget: "dict | None" = None,  # T103: ContextBudget.get_all() dict
) -> dict[str, Any]:
    _sse = send_sse or (lambda e: None)

    async def _run_phase4_once(initial_state: Phase4State) -> Phase4State:
        state: Any = initial_state
        for fn in [
            sa1_hoppscotch_api_test,
            sa2_sast_scan,
            sa3_dast_scan,
            sa4_requirement_check,
            sa5_cicd_testing,
            sa6_cyber_security,
            sa7_generate_reports_and_fixes,
        ]:
            state = await fn(state)
        return state

    # T-A03: Load Phase 1 context from Mem0 for continuity
    try:
        from ..shared.mem0_context import retrieve_phase1_context  # noqa: PLC0415
        _mem0_ctx = retrieve_phase1_context(user_id, project_dir)
    except Exception:
        _mem0_ctx = ""
    # T-P4-07: Load Phase 3 validation results for retry patch context
    try:
        import json as _json_p3  # noqa: PLC0415
        from ..shared.paths import get_phase_dir as _gpd4  # noqa: PLC0415
        _val_p3_path = _gpd4(project_dir, 3, create=False) / "phase-3-validation.json"
        _p3_validation: dict = _json_p3.loads(_val_p3_path.read_text()) if _val_p3_path.exists() else {}
    except Exception:
        _p3_validation = {}
    retry_limit = int(os.environ.get("PAKALON_PHASE4_MAX_RETRIES", "5"))
    retry_count = 0
    latest_state: Phase4State = {}
    latest_validation = _p3_validation

    while True:
        initial: Phase4State = {
            "project_dir": project_dir,
            "target_url": target_url,
            "user_id": user_id,
            "user_plan": user_plan,
            "is_yolo": is_yolo,
            "send_sse": _sse,
            "context_budget": context_budget,
            "_mem0_context": _mem0_ctx,
            "retry_count": retry_count,
            "phase3_validation_results": latest_validation,  # T-P4-07
            "phase3_findings": latest_state.get("phase3_findings", []),
        }
        state = await _run_phase4_once(initial)
        latest_state = state

        qa_report = state.get("qa_report") or {}
        overall_score = int(qa_report.get("overall_score", 100) or 100)
        needs_retry = bool(state.get("needs_phase3_retry"))
        if not needs_retry:
            break

        if retry_count >= retry_limit:
            _sse({
                "type": "text_delta",
                "content": (
                    f"\n⚠️  Maximum Phase 4 retry limit ({retry_limit}) reached with score "
                    f"{overall_score}/100. Stopping automatic retries.\n"
                ),
            })
            break

        retry_count += 1
        _sse({
            "type": "text_delta",
            "content": (
                f"\n🔁 Phase 4 retry loop {retry_count}/{retry_limit}: sending actionable findings back "
                f"to Phase 3.\n"
            ),
        })

        try:
            from ..phase3.graph import run_phase3  # noqa: PLC0415

            patch_plan = _generate_retry_patch_plan(state)
            _sse({
                "type": "text_delta",
                "content": (
                    f"  Patch plan prepared: {len(patch_plan.get('issues', []))} issue(s), "
                    f"{len(patch_plan.get('files_to_patch', []))} file(s).\n"
                ),
            })

            retry_result = await run_phase3(
                project_dir=project_dir,
                user_id=user_id,
                is_yolo=True,
                send_sse=_sse,
                input_queue=input_queue,
                retry_patch_plan=patch_plan,
            )
            _sse({
                "type": "text_delta",
                "content": (
                    f"  Phase 3 retry complete: {len(retry_result.get('outputs_saved', []))} artifact(s) updated. "
                    "Re-running Phase 4 validation...\n"
                ),
            })
            latest_validation = retry_result.get("validation", {}) or latest_validation
        except Exception as re_err:
            _sse({"type": "text_delta", "content": f"  Phase 3 re-entry failed: {re_err}\n"})
            break

    state = latest_state
    # T-RAG-01C: store Phase 4 summary in Mem0
    try:
        from ..shared.langgraph_checkpointer import store_phase_mem0  # noqa: PLC0415
        _p4_score = (state.get("qa_report") or {}).get("overall_score", "N/A")
        store_phase_mem0(user_id, project_dir, phase=4, summary=f"QA score: {_p4_score}")
    except Exception:
        pass

    return {
        "status": "complete",
        "outputs_saved": state.get("outputs_saved", []),
        "phase3_findings": state.get("phase3_findings", []),  # GAP-P0-01: Return findings for retry loop
        "needs_phase3_retry": state.get("needs_phase3_retry", False),
        "overall_score": (state.get("qa_report") or {}).get("overall_score"),
        "retry_count": retry_count,
    }
