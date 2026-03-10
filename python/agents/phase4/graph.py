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

    sast_sum = sast.get("summary", {})
    dast_sum = dast.get("summary", {})
    req_sum = state.get("requirement_results", {}).get("summary", {})
    cicd_sum = state.get("cicd_results", {}).get("summary", {})
    cyber_sum = state.get("cyber_results", {}).get("summary", {})

    hop_sum = state.get("hoppscotch_results", {}).get("summary", {})
    phase4_md = (
        "# Phase 4: Security & QA\n\n"
        "## Results\n\n"
        "| Check | Total | High Severity | Status |\n"
        "|-------|-------|---------------|--------|\n"
        f"| Hoppscotch API Tests | {hop_sum.get('total_findings',0)} | {hop_sum.get('critical',0)+hop_sum.get('high_severity',0)} | {'✅' if hop_sum.get('passed', True) else '❌'} ({hop_sum.get('security_score',100)}/100) |\n"
        f"| SAST | {sast_sum.get('total_findings',0)} | {sast_sum.get('high_severity',0)} | {'✅' if sast_sum.get('passed') else '❌'} |\n"
        f"| DAST | {dast_sum.get('total_findings',0)} | {dast_sum.get('high_severity',0)} | {'✅' if dast_sum.get('passed') else '❌'} |\n"
        f"| CI/CD | {len(state.get('cicd_results', {}).get('findings', []))} | — | {'✅' if cicd_sum.get('passed', True) else '❌'} |\n"
        f"| Cyber Security | {cyber_sum.get('total_findings',0)} | {cyber_sum.get('critical',0)+cyber_sum.get('high_severity',0)} | {'✅' if cyber_sum.get('passed', True) else '❌'} ({cyber_sum.get('security_score',100)}/100) |\n"
        f"| Requirements | {req_sum.get('total',0)} | — | {'✅' if req_sum.get('met_threshold') else '❌'} ({req_sum.get('pass_rate',0):.0%}) |\n\n"
        "## Sub-Agent Reports\n\n"
        "- `phase-4/subagent-1.md` — Hoppscotch API security tests\n"
        "- `phase-4/subagent-2.md` — SAST results\n"
        "- `phase-4/subagent-3.md` — DAST results\n"
        "- `phase-4/subagent-4.md` — Requirement coverage\n"
        "- `phase-4/subagent-5.md` — CI/CD pipeline analysis\n"
        "- `phase-4/subagent-6.md` — Cyber security attack simulation\n\n"
        "## XML/HTML Reports\n\n"
        + "\n".join(f"- `{p}`" for p in paths) + "\n\n"
        "## Machine-readable Summary\n\n"
        "- `phase-4-security-summary.json` — Consolidated SAST/DAST/CI-CD/Cyber/Requirements status\n\n"
        "## Fix Suggestions\n\n"
        + ("\n".join(f"- **{s.get('finding_rule', '')}**: {s.get('fix_description', '')}" for s in suggestions[:5])
            or "No high-severity findings requiring fixes.") + "\n"
    )

    security_summary = {
        "status": "complete",
        "hoppscotch": {
            "total_findings": hop_sum.get("total_findings", 0),
            "high_or_critical": hop_sum.get("critical", 0) + hop_sum.get("high_severity", 0),
            "security_score": hop_sum.get("security_score", 100),
            "endpoints_tested": hop_sum.get("endpoints_tested", 0),
            "passed": hop_sum.get("passed", True),
        },
        "sast": {
            "total_findings": sast_sum.get("total_findings", 0),
            "high_severity": sast_sum.get("high_severity", 0),
            "passed": sast_sum.get("passed", True),
        },
        "dast": {
            "total_findings": dast_sum.get("total_findings", 0),
            "high_severity": dast_sum.get("high_severity", 0),
            "passed": dast_sum.get("passed", True),
        },
        "cicd": {
            "findings": len(state.get("cicd_results", {}).get("findings", [])),
            "passed": cicd_sum.get("passed", True),
        },
        "cyber": {
            "total_findings": cyber_sum.get("total_findings", 0),
            "high_or_critical": cyber_sum.get("critical", 0) + cyber_sum.get("high_severity", 0),
            "security_score": cyber_sum.get("security_score", 100),
            "passed": cyber_sum.get("passed", True),
        },
        "requirements": {
            "total": req_sum.get("total", 0),
            "pass_rate": req_sum.get("pass_rate", 0),
            "met_threshold": req_sum.get("met_threshold", True),
        },
        "needs_phase3_retry": state.get("needs_phase3_retry", False),
    }
    security_summary_path = out_dir / "phase-4-security-summary.json"
    security_summary_path.write_text(json.dumps(security_summary, indent=2))

    (out_dir / "phase-4.md").write_text(phase4_md)
    all_outputs = paths + [str(security_summary_path), str(out_dir / "phase-4.md")]
    state["outputs_saved"] = all_outputs

    # Record security findings in cross-phase decision registry
    project_dir_str = str(state.get("project_dir", "."))
    total_findings = sast_sum.get("total", 0) + dast_sum.get("total", 0)
    record_decision(
        project_dir_str,
        phase=4,
        decision_type="security_audit",
        description=(
            f"Security scan: {total_findings} total findings — "
            f"SAST passed={sast_sum.get('passed', True)}, "
            f"DAST passed={dast_sum.get('passed', True)}, "
            f"requirements met={req_sum.get('met_threshold', True)}"
        ),
        source_file="phase-4/phase-4.md",
        metadata={
            "sast_summary": sast_sum,
            "dast_summary": dast_sum,
            "requirements_summary": req_sum,
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
    # T-CLI-14: Check if Phase 3 retry is needed based on security findings
    # If there are high/critical findings, trigger Phase 3 re-run
    retry_count = state.get("retry_count", 0)
    max_retries = 3
    
    # Determine if retry is needed
    needs_retry = (
        not sast_sum.get("passed", True) or
        not dast_sum.get("passed", True) or
        not req_sum.get("met_threshold", True) or
        len(high_findings) > 0
    )
    
    if needs_retry and retry_count < max_retries:
        state["needs_phase3_retry"] = True
        state["retry_count"] = retry_count + 1
        state["phase3_findings"] = high_findings
        
        # Emit retry event to trigger Phase 3 re-run
        sse({
            "type": "phase3_retry_request",
            "message": f"Phase 4 found {len(high_findings)} high-severity issues. Triggering Phase 3 retry {retry_count + 1}/{max_retries}",
            "findings": high_findings[:10],  # Send top 10 findings
            "retry_count": retry_count + 1,
            "max_retries": max_retries,
        })
        sse({"type": "text_delta", "content": f"\n🔄 Issues found! Requesting Phase 3 retry {retry_count + 1}/{max_retries} to fix security issues.\n"})
    else:
        state["needs_phase3_retry"] = False
        if retry_count >= max_retries:
            sse({"type": "text_delta", "content": f"\n⚠️  Maximum retry limit ({max_retries}) reached. Moving to completion.\n"})
    
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

    # SA1: Hoppscotch API security findings
    hop = state.get("hoppscotch_results", {})
    for f in hop.get("findings", []):
        sev = f.get("severity", "LOW")
        if sev in ("CRITICAL", "HIGH", "MEDIUM"):
            entry = {
                "severity": sev,
                "type": f.get("type", "HOPPSCOTCH_API_FINDING"),
                "description": f.get("description", ""),
                "recommendation": f.get("recommendation", "Fix the identified API security vulnerability"),
                "file_path": f.get("file_path", ""),
                "source": "hoppscotch",
            }
            issues.append(entry)
            if entry["file_path"]:
                files_to_patch.add(entry["file_path"])

    # SAST findings → map source files
    sast = state.get("sast_results", {})
    for f in sast.get("findings", []):
        sev = f.get("severity", "LOW")
        if sev in ("CRITICAL", "HIGH", "MEDIUM"):
            entry = {
                "severity": sev,
                "type": f.get("type", f.get("rule", "SAST_FINDING")),
                "description": f.get("description", f.get("message", "")),
                "recommendation": f.get("recommendation", f.get("fix", "Fix the identified security vulnerability")),
                "file_path": f.get("file_path", f.get("file", "")),
                "source": "sast",
            }
            issues.append(entry)
            if entry["file_path"]:
                files_to_patch.add(entry["file_path"])

    # Requirement check → unmet requirements indicate missing implementations
    req = state.get("requirement_results", {})
    requirements_missing: list[str] = []
    for item in req.get("items", []):
        if item.get("status") != "pass":
            desc = item.get("requirement", "")
            requirements_missing.append(desc)
            issues.append({
                "severity": "HIGH",
                "type": "REQUIREMENT_NOT_MET",
                "description": desc,
                "recommendation": "Implement the missing feature/behaviour described",
                "file_path": item.get("file_path", ""),
                "source": "requirements",
            })
            if item.get("file_path"):
                files_to_patch.add(item["file_path"])

    # DAST findings with file hints
    dast = state.get("dast_results", {})
    for f in dast.get("findings", []):
        sev = f.get("severity", "LOW")
        if sev in ("CRITICAL", "HIGH"):
            entry = {
                "severity": sev,
                "type": f.get("type", "DAST_FINDING"),
                "description": f.get("description", ""),
                "recommendation": f.get("recommendation", "Fix the identified vulnerability"),
                "file_path": f.get("file_path", ""),
                "source": "dast",
            }
            issues.append(entry)
            if entry["file_path"]:
                files_to_patch.add(entry["file_path"])

    # Phase 3 findings carried forward from previous retry
    for f in state.get("phase3_findings", []):
        if f not in issues:
            issues.append(f)
            if f.get("file_path"):
                files_to_patch.add(f["file_path"])

    # T-P4-07: Include Phase 3 agent_browser + tdd_loop findings for targeted retry guidance
    p3_val = state.get("phase3_validation_results", {})
    ab_findings = p3_val.get("agent_browser", {})
    tdd_findings = p3_val.get("tdd_loop", {})

    # Console errors captured by AgentBrowser in Phase 3 SA4
    for err in (ab_findings.get("console_errors") or []):
        issues.append({
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
        issues.append({
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
            issues.append({
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
    initial: Phase4State = {
        "project_dir": project_dir,
        "target_url": target_url,
        "user_id": user_id,
        "user_plan": user_plan,
        "is_yolo": is_yolo,
        "send_sse": _sse,
        "context_budget": context_budget,
        "_mem0_context": _mem0_ctx,
        "phase3_validation_results": _p3_validation,  # T-P4-07
    }
    graph = build_phase4_graph()
    _user_id4 = state_in.get("user_id", "anonymous")
    _project_dir4 = state_in.get("project_dir", ".")
    if graph is None:
        state: Any = initial
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
    else:
        try:
            from ..shared.langgraph_checkpointer import thread_config as _tc4  # noqa: PLC0415
            _cfg4 = _tc4(_user_id4, _project_dir4, phase=4)
        except Exception:
            _cfg4 = {}
        state = await graph.ainvoke(initial, config=_cfg4)
    # T-RAG-01C: store Phase 4 summary in Mem0
    try:
        from ..shared.langgraph_checkpointer import store_phase_mem0  # noqa: PLC0415
        _p4_score = (state.get("qa_report") or {}).get("overall_score", "N/A")
        store_phase_mem0(_user_id4, _project_dir4, phase=4, summary=f"QA score: {_p4_score}")
    except Exception:
        pass

    # T-CLI-23: Re-entry into Phase 3 if requirement coverage is too low
    if state.get("needs_phase3_retry"):
        _sse({"type": "text_delta", "content": "\n🔄 Re-entering Phase 3 to fill missing requirements...\n"})
        try:
            from ..phase3.graph import run_phase3  # noqa: PLC0415

            # Build a targeted patch plan so Phase 3 focuses only on broken areas
            patch_plan = _generate_retry_patch_plan(state)
            if patch_plan:
                _sse({
                    "type": "text_delta",
                    "content": f"  Patch plan: {len(patch_plan['files_to_patch'])} files targeted, "
                               f"{len(patch_plan['issues'])} issues to fix.\n",
                })

            retry_result = await run_phase3(
                project_dir=project_dir,
                user_id=user_id,
                is_yolo=True,  # auto-mode for re-entry (no user confirmation needed)
                send_sse=_sse,
                input_queue=input_queue,
                retry_patch_plan=patch_plan,  # Pass targeted patch context
            )
            _sse({"type": "text_delta", "content": f"  Phase 3 retry complete: {len(retry_result.get('outputs_saved', []))} files updated.\n"})
            # T-P4-07: Update state with fresh Phase 3 validation so subsequent retries have current context
            fresh_p3_val = retry_result.get("validation", {})
            if fresh_p3_val:
                state["phase3_validation_results"] = fresh_p3_val
        except Exception as re_err:
            _sse({"type": "text_delta", "content": f"  Phase 3 re-entry failed: {re_err}\n"})

    return {
        "status": "complete",
        "outputs_saved": state.get("outputs_saved", []),
        "phase3_findings": state.get("phase3_findings", []),  # GAP-P0-01: Return findings for retry loop
        "needs_phase3_retry": state.get("needs_phase3_retry", False),
    }
