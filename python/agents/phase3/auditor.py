"""
auditor.py — Phase 3 Auditor Agent for Pakalon

Async agent that audits the entire codebase against Phase 1 requirements and
generates a versioned auditor.md report with missing / partial / complete
feature breakdown.  Supports both HIL and YOLO loop modes.

Features:
- Full async LLM-powered deep analysis via OpenRouter
- SSE streaming for real-time progress updates
- Mem0 storage of audit findings for cross-phase continuity
- HIL mode: presents choices, awaits user decision, calls relevant sub-agents
- YOLO mode: auto-selects "implement all", loops up to max_iterations (default 10)
- Overwrites auditor.md on each iteration; stops when 100% complete or max loops
- Read-only codebase scan (never modifies project files directly)
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
from datetime import datetime
from typing import Any, TypedDict
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_PHASE1_REQ_FILES = [
    "plan.md",
    "tasks.md",
    "design.md",
    "user-stories.md",
    "prd.md",
    "technical-spec.md",
    "risk-assessment.md",
    "API_reference.md",
    "Database_schema.md",
]

_CODE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".swift", ".kt"}

_SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".pakalon-agents", "dist", "build", ".next", "venv", "env"}


# ---------------------------------------------------------------------------
# Helper: LLM call
# ---------------------------------------------------------------------------

async def _llm(messages: list[dict], max_tokens: int = 4096) -> str:
    """Call OpenRouter LLM and return the response text."""
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        return "// [No OPENROUTER_API_KEY set]"
    try:
        import httpx
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": os.environ.get("PAKALON_MODEL", "anthropic/claude-3-5-haiku"),
                    "messages": messages,
                    "max_tokens": max_tokens,
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:
        return f"// [LLM error: {exc}]"


# ---------------------------------------------------------------------------
# Read-only codebase scanner
# ---------------------------------------------------------------------------

def _scan_codebase(project_dir: Path) -> dict[str, Any]:
    """
    Walk the project directory (read-only) and collect file metadata.
    Returns a dict with file lists, detected technologies, API hints, etc.
    """
    results: dict[str, Any] = {
        "files": [],
        "api_endpoint_files": [],
        "db_model_files": [],
        "frontend_component_files": [],
        "technologies": set(),
        "total_lines": 0,
    }

    for fp in project_dir.rglob("*"):
        # Skip unwanted dirs early
        if any(skip in fp.parts for skip in _SKIP_DIRS):
            continue
        if not fp.is_file():
            continue
        if fp.suffix not in _CODE_EXTENSIONS:
            continue

        rel = str(fp.relative_to(project_dir))
        results["files"].append(rel)

        # Read first 4 KB for heuristics
        try:
            snippet = fp.read_text(encoding="utf-8", errors="ignore")[:4096]
        except Exception:
            snippet = ""

        lo = snippet.lower()

        # Technology detection
        if "react" in lo or "jsx" in lo:
            results["technologies"].add("React")
        if '"next"' in lo or "from 'next'" in lo or "next/app" in lo:
            results["technologies"].add("Next.js")
        if "fastapi" in lo:
            results["technologies"].add("FastAPI")
        if "flask" in lo:
            results["technologies"].add("Flask")
        if "express" in lo or "app.listen" in lo:
            results["technologies"].add("Express")
        if "postgresql" in lo or "pg." in lo:
            results["technologies"].add("PostgreSQL")
        if "sqlite" in lo:
            results["technologies"].add("SQLite")
        if "prisma" in lo:
            results["technologies"].add("Prisma")
        if "sqlalchemy" in lo:
            results["technologies"].add("SQLAlchemy")
        if "tailwind" in lo:
            results["technologies"].add("Tailwind CSS")
        if "drizzle" in lo:
            results["technologies"].add("Drizzle ORM")
        if "graphql" in lo:
            results["technologies"].add("GraphQL")
        if "docker" in lo:
            results["technologies"].add("Docker")

        # API endpoint files
        if any(pat in lo for pat in ("@app.get", "@app.post", "@router.get", "@router.post",
                                     "router.get(", "router.post(", "app.get(", "app.post(")):
            results["api_endpoint_files"].append(rel)

        # DB model files
        if any(pat in lo for pat in ("class.*model", "create table", "schema {", "sqlalchemy.orm")):
            results["db_model_files"].append(rel)

        # Frontend component files
        if fp.suffix in {".tsx", ".jsx"} and any(pat in lo for pat in ("export default", "export const", "return (")):
            results["frontend_component_files"].append(rel)

        # Line count
        results["total_lines"] += snippet.count("\n")

    results["technologies"] = sorted(results["technologies"])
    return results


# ---------------------------------------------------------------------------
# Load requirements from Phase 1
# ---------------------------------------------------------------------------

def _load_requirements(project_dir: Path) -> dict[str, str]:
    """Load all Phase 1 requirement files from .pakalon-agents/ai-agents/phase-1/."""
    phase1_dir = project_dir / ".pakalon-agents" / "ai-agents" / "phase-1"
    reqs: dict[str, str] = {}
    for filename in _PHASE1_REQ_FILES:
        fp = phase1_dir / filename
        if fp.exists():
            try:
                reqs[filename] = fp.read_text(encoding="utf-8")
            except Exception:
                pass
    return reqs


# ---------------------------------------------------------------------------
# LLM-powered audit analysis
# ---------------------------------------------------------------------------

async def _llm_audit_analysis(
    requirements: dict[str, str],
    scan: dict[str, Any],
    iteration: int,
    sse: Any,
) -> dict[str, Any]:
    """
    Use LLM to deep-compare requirements against the scanned codebase and
    return a structured analysis dict.
    """
    sse({"type": "text_delta", "content": f"  🤖 Running LLM analysis (iteration {iteration})...\n"})

    req_summary = "\n\n".join(
        f"### {name}\n{content[:1500]}"
        for name, content in list(requirements.items())[:6]
    )

    scan_summary = (
        f"Files: {len(scan['files'])} | "
        f"API files: {len(scan['api_endpoint_files'])} | "
        f"DB model files: {len(scan['db_model_files'])} | "
        f"Frontend components: {len(scan['frontend_component_files'])} | "
        f"Technologies: {', '.join(scan['technologies']) or 'none detected'}\n\n"
        f"Sample files:\n" + "\n".join(f"  - {f}" for f in scan["files"][:40])
    )

    prompt = (
        "You are a senior software auditor. Given these Phase 1 requirements and a codebase scan, "
        "produce a structured JSON audit report.\n\n"
        f"## Phase 1 Requirements\n\n{req_summary}\n\n"
        f"## Codebase Scan\n\n{scan_summary}\n\n"
        "Return ONLY JSON in exactly this shape:\n"
        '{"completed": [{"name": "...", "detail": "..."}], '
        '"partial": [{"name": "...", "detail": "...", "gap": "..."}], '
        '"missing": [{"name": "...", "detail": "...", "priority": "high|medium|low"}], '
        '"completion_pct": 0-100, '
        '"summary": "One paragraph executive summary", '
        '"recommended_action": "implement_all|implement_core|nothing"}'
    )

    raw = await _llm([{"role": "user", "content": prompt}], max_tokens=3000)

    # Parse JSON
    import re
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except Exception:
            pass

    # Fallback minimal analysis
    return {
        "completed": [],
        "partial": [],
        "missing": [{"name": "Analysis failed — LLM returned unparseable output", "detail": raw[:300], "priority": "high"}],
        "completion_pct": 0,
        "summary": "Audit analysis could not be parsed.",
        "recommended_action": "implement_all",
    }


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def _build_report(
    project_name: str,
    analysis: dict[str, Any],
    scan: dict[str, Any],
    iteration: int,
    max_iterations: int,
) -> str:
    """Render the auditor.md report markdown from an analysis dict."""
    pct = analysis.get("completion_pct", 0)
    completed = analysis.get("completed", [])
    partial = analysis.get("partial", [])
    missing = analysis.get("missing", [])
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lines: list[str] = [
        f"# Auditor Report — Iteration {iteration}",
        "",
        f"> **Project:** `{project_name}`  ",
        f"> **Generated:** {ts}  ",
        f"> **Iteration:** {iteration}/{max_iterations}",
        "",
        "---",
        "",
        "## Executive Summary",
        "",
        analysis.get("summary", ""),
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Overall Completion | **{pct}%** |",
        f"| ✅ Completed | {len(completed)} |",
        f"| ⚠️  Partial | {len(partial)} |",
        f"| ❌ Missing | {len(missing)} |",
        f"| Code Files | {len(scan.get('files', []))} |",
        f"| Technologies | {', '.join(scan.get('technologies', [])) or 'N/A'} |",
        "",
        "---",
        "",
        "## ✅ Completed Features",
        "",
    ]

    if completed:
        for item in completed:
            lines.append(f"- **{item.get('name', item)}** — {item.get('detail', '')}")
    else:
        lines.append("_None detected yet._")

    lines += [
        "",
        "---",
        "",
        "## ⚠️  Partially Implemented Features",
        "",
    ]

    if partial:
        for item in partial:
            lines.append(f"- **{item.get('name', item)}**")
            if item.get("detail"):
                lines.append(f"  - _What exists:_ {item['detail']}")
            if item.get("gap"):
                lines.append(f"  - _Gap:_ {item['gap']}")
    else:
        lines.append("_None detected._")

    lines += [
        "",
        "---",
        "",
        "## ❌ Missing Features",
        "",
    ]

    if missing:
        for item in missing:
            priority = item.get("priority", "medium")
            badge = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(priority, "⚪")
            lines.append(f"- {badge} **{item.get('name', item)}** ({priority} priority)")
            if item.get("detail"):
                lines.append(f"  > {item['detail']}")
    else:
        lines.append("_No missing features — requirements fully satisfied!_ 🎉")

    lines += [
        "",
        "---",
        "",
        "## Technology Stack",
        "",
        "| Technology | Status |",
        "|-----------|--------|",
    ]
    for tech in scan.get("technologies", []):
        lines.append(f"| {tech} | Detected ✓ |")

    lines += [
        "",
        "---",
        "",
        "## Codebase Statistics",
        "",
        f"- **Total source files:** {len(scan.get('files', []))}",
        f"- **API endpoint files:** {len(scan.get('api_endpoint_files', []))}",
        f"- **Database model files:** {len(scan.get('db_model_files', []))}",
        f"- **Frontend component files:** {len(scan.get('frontend_component_files', []))}",
        "",
        "---",
        "",
        "*Generated by the Pakalon Auditor Agent*",
        "",
    ]

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Save report + Mem0
# ---------------------------------------------------------------------------

def _save_report(phase3_dir: Path, report: str) -> Path:
    """Write auditor.md to the phase-3 directory."""
    phase3_dir.mkdir(parents=True, exist_ok=True)
    out = phase3_dir / "auditor.md"
    out.write_text(report, encoding="utf-8")
    return out


def _save_to_mem0(user_id: str, project_dir: str, analysis: dict[str, Any], iteration: int) -> None:
    """Persist audit findings to Mem0 for cross-phase continuity."""
    try:
        from ..shared.mem0_context import save_phase_context  # noqa: PLC0415
        payload = {
            "phase": "3-auditor",
            "iteration": iteration,
            "completion_pct": analysis.get("completion_pct", 0),
            "missing_count": len(analysis.get("missing", [])),
            "partial_count": len(analysis.get("partial", [])),
            "completed_count": len(analysis.get("completed", [])),
            "summary": analysis.get("summary", "")[:400],
        }
        save_phase_context(user_id, project_dir, json.dumps(payload))
    except Exception:
        pass  # Mem0 is best-effort


# ---------------------------------------------------------------------------
# Graph node: run_auditor
# ---------------------------------------------------------------------------

async def run_auditor(state: Any) -> Any:
    """
    LangGraph node — Phase 3 Auditor.

    Reads the codebase (read-only), compares with Phase 1 requirements,
    generates/overwrites auditor.md, and handles HIL/YOLO decision loop.
    """
    sse = state.get("send_sse") or (lambda e: None)
    project_dir = pathlib.Path(state.get("project_dir", "."))
    user_id: str = state.get("user_id", "anonymous")
    is_yolo: bool = state.get("is_yolo", False)
    input_queue: asyncio.Queue | None = state.get("_input_queue")  # type: ignore[assignment]
    iteration: int = state.get("auditor_iteration", 0) + 1
    max_iterations: int = state.get("auditor_max_iterations", 10 if is_yolo else 3)

    phase3_dir = project_dir / ".pakalon-agents" / "ai-agents" / "phase-3"

    sse({"type": "text_delta", "content": f"\n🔍 Auditor Agent — iteration {iteration}/{max_iterations}\n"})
    sse({"type": "text_delta", "content": "  📂 Scanning codebase (read-only)...\n"})

    # 1. Scan codebase (read-only)
    scan = _scan_codebase(project_dir)
    sse({"type": "text_delta", "content": f"  Found {len(scan['files'])} source files across {len(scan['technologies'])} detected technologies\n"})

    # 2. Load Phase 1 requirements
    requirements = _load_requirements(project_dir)
    sse({"type": "text_delta", "content": f"  📋 Loaded {len(requirements)} requirement documents from Phase 1\n"})

    # 3. LLM analysis
    analysis = await _llm_audit_analysis(requirements, scan, iteration, sse)
    pct: float = analysis.get("completion_pct", 0)
    sse({"type": "text_delta", "content": f"  📊 Completion: {pct}% | ✅ {len(analysis.get('completed', []))} | ⚠️ {len(analysis.get('partial', []))} | ❌ {len(analysis.get('missing', []))}\n"})

    # 4. Save report
    report = _build_report(project_dir.name, analysis, scan, iteration, max_iterations)
    report_path = _save_report(phase3_dir, report)
    sse({"type": "text_delta", "content": f"  📝 auditor.md written → {report_path}\n"})

    # 5. Save to Mem0
    _save_to_mem0(user_id, str(project_dir), analysis, iteration)

    # 6. Update state
    state["auditor_result"] = analysis
    state["auditor_iteration"] = iteration
    state["auditor_max_iterations"] = max_iterations

    # 7. Decision: complete?
    if pct >= 100:
        sse({"type": "text_delta", "content": "  🎉 All requirements satisfied — auditor loop complete!\n"})
        sse({"type": "auditor_complete", "completion_pct": 100, "report_path": str(report_path)})
        return state

    if iteration >= max_iterations:
        sse({"type": "text_delta", "content": f"  ⚠️  Max iterations ({max_iterations}) reached — stopping audit loop.\n"})
        sse({"type": "auditor_complete", "completion_pct": pct, "report_path": str(report_path)})
        return state

    # 8. YOLO mode: auto-decide and trigger re-implementation via SA1–SA4
    if is_yolo:
        recommended = analysis.get("recommended_action", "implement_all")
        sse({"type": "text_delta", "content": f"  🤖 YOLO mode — auto-action: {recommended}\n"})

        if recommended in ("implement_all", "implement_core"):
            sse({"type": "text_delta", "content": "  🔁 Re-running SA1–SA4 to address missing/partial features...\n"})

            # Build an amended state with auditor findings injected into plan context
            missing_txt = "\n".join(
                f"- {item.get('name', item)} ({item.get('priority','medium')} priority)"
                for item in analysis.get("missing", [])[:20]
            )
            partial_txt = "\n".join(
                f"- {item.get('name', item)}: {item.get('gap','')}"
                for item in analysis.get("partial", [])[:10]
            )
            auditor_note = (
                f"\n\n## Auditor Feedback (Iteration {iteration})\n"
                f"Completion: {pct}%\n\n"
                f"### Missing Features\n{missing_txt}\n\n"
                f"### Partial Features\n{partial_txt}\n"
            )

            amended: Any = dict(state)
            ps = dict(amended.get("phase1_summary") or {})
            ps["plan.md"] = ps.get("plan.md", "") + auditor_note
            amended["phase1_summary"] = ps

            # Import SA functions locally to avoid circular imports at module top-level
            from .graph import (  # noqa: PLC0415
                sa1_frontend_design,
                sa2_backend_frame,
                sa3_integration_wiring,
                sa4_debugging_testing,
            )
            for sa_fn in [sa1_frontend_design, sa2_backend_frame, sa3_integration_wiring, sa4_debugging_testing]:
                amended = await sa_fn(amended)

            # Merge file lists back
            for key in ("scaffolded_files", "component_files", "logic_files", "integration_files", "validation_results"):
                if key in amended:
                    state[key] = amended[key]

        # Loop — next auditor run will be triggered by the graph's conditional edge
        return state

    # 9. HIL mode: present choice prompt
    missing_list = "\n".join(
        f"  {i+1}. {item.get('name', item)}"
        for i, item in enumerate(analysis.get("missing", [])[:15])
    )
    partial_list = "\n".join(
        f"  - {item.get('name', item)}"
        for item in analysis.get("partial", [])[:10]
    )

    sse({
        "type": "choice_request",
        "message": (
            f"Auditor Report — Iteration {iteration}\n\n"
            f"Completion: **{pct}%**\n\n"
            f"Missing features:\n{missing_list or '  (none)'}\n\n"
            f"Partial features:\n{partial_list or '  (none)'}"
        ),
        "question": "What would you like to do?",
        "choices": [
            {"id": "implement_all",  "label": "🚀 Implement ALL missing + partial features"},
            {"id": "implement_core", "label": "🎯 Implement CORE / high-priority features only"},
            {"id": "nothing",        "label": "⏭️  Do nothing — proceed to next phase"},
        ],
    })

    answer = "implement_all"
    if input_queue is not None:
        try:
            answer = str(await asyncio.wait_for(input_queue.get(), timeout=300.0))
        except asyncio.TimeoutError:
            answer = "implement_all"

    if answer == "nothing":
        sse({"type": "text_delta", "content": "  ⏭️  No action taken — proceeding.\n"})
        return state

    # Ask for codebase-specific questions if HIL
    sse({"type": "awaiting_input", "prompt": (
        "Any specific instructions for the implementation? "
        "(e.g. 'focus on auth and payment; use existing DB schema') — or press Enter to skip:"
    )})
    extra_instructions = ""
    if input_queue is not None:
        try:
            extra_instructions = str(await asyncio.wait_for(input_queue.get(), timeout=180.0))
        except asyncio.TimeoutError:
            extra_instructions = ""

    # Also ask iteration count preference (HIL only)
    sse({"type": "awaiting_input", "prompt": (
        f"How many more audit loop iterations would you like? (current: {iteration}/{max_iterations}, max 10) — "
        "Enter a number or press Enter to keep current max:"
    )})
    iter_input = ""
    if input_queue is not None:
        try:
            iter_input = str(await asyncio.wait_for(input_queue.get(), timeout=60.0))
        except asyncio.TimeoutError:
            iter_input = ""
    if iter_input.strip().isdigit():
        state["auditor_max_iterations"] = min(10, max(iteration + 1, int(iter_input.strip())))

    # Re-run SA1–SA4 with auditor context injected
    sse({"type": "text_delta", "content": f"  🔁 Implementing {answer.replace('_', ' ')} features...\n"})

    missing_txt = "\n".join(
        f"- {item.get('name', item)} ({item.get('priority','medium')} priority)"
        for item in (
            analysis.get("missing", []) if answer == "implement_all"
            else [x for x in analysis.get("missing", []) if x.get("priority") == "high"]
        )[:20]
    )
    if extra_instructions:
        missing_txt += f"\n\nUser instructions: {extra_instructions}"

    auditor_note = (
        f"\n\n## Auditor Feedback (Iteration {iteration})\n"
        f"Completion: {pct}%\n\n"
        f"### Requested Changes\n{missing_txt}\n"
    )

    amended2: Any = dict(state)
    ps2 = dict(amended2.get("phase1_summary") or {})
    ps2["plan.md"] = ps2.get("plan.md", "") + auditor_note
    amended2["phase1_summary"] = ps2

    from .graph import (  # noqa: PLC0415
        sa1_frontend_design,
        sa2_backend_frame,
        sa3_integration_wiring,
        sa4_debugging_testing,
    )
    for sa_fn in [sa1_frontend_design, sa2_backend_frame, sa3_integration_wiring, sa4_debugging_testing]:
        amended2 = await sa_fn(amended2)

    for key in ("scaffolded_files", "component_files", "logic_files", "integration_files", "validation_results"):
        if key in amended2:
            state[key] = amended2[key]

    return state


# ---------------------------------------------------------------------------
# Standalone runner (called from /auditor CLI command via bridge)
# ---------------------------------------------------------------------------

async def run_auditor_standalone(
    project_dir: str,
    user_id: str = "anonymous",
    is_yolo: bool = False,
    send_sse: Any = None,
    input_queue: Any = None,
    max_iterations: int = 3,
) -> dict[str, Any]:
    """
    Entry point for the /auditor CLI command.

    Does NOT require a full Phase 3 graph run — can be invoked independently
    after any phase to audit the current project state.
    """
    sse = send_sse or (lambda e: None)

    # Build a minimal Phase3State-compatible dict
    state: dict[str, Any] = {
        "project_dir": project_dir,
        "user_id": user_id,
        "is_yolo": is_yolo,
        "send_sse": sse,
        "_input_queue": input_queue,
        "auditor_iteration": 0,
        "auditor_max_iterations": max_iterations,
        "auditor_result": None,
        # Load phase summaries if available
        "phase1_summary": {},
        "phase2_summary": {},
        "scaffolded_files": [],
        "component_files": [],
        "logic_files": [],
        "integration_files": [],
        "validation_results": {},
        "is_yolo": is_yolo,
    }

    # Run audit loop
    _current_iter = 0
    _max_iter = max_iterations
    while _current_iter < _max_iter:
        state = await run_auditor(state)
        _current_iter = state.get("auditor_iteration", _current_iter + 1)
        pct = (state.get("auditor_result") or {}).get("completion_pct", 0)

        if pct >= 100:
            break
        if _current_iter >= _max_iter:
            break
        if not is_yolo:
            # HIL: one iteration per user interaction, loop broken by choice
            break

    phase3_dir = pathlib.Path(project_dir) / ".pakalon-agents" / "ai-agents" / "phase-3"
    report_path = phase3_dir / "auditor.md"
    return {
        "status": "complete",
        "report_path": str(report_path),
        "report": report_path.read_text(encoding="utf-8") if report_path.exists() else "",
        "completion_pct": (state.get("auditor_result") or {}).get("completion_pct", 0),
        "iterations": state.get("auditor_iteration", 0),
    }


# ---------------------------------------------------------------------------
# Legacy sync convenience shim (backward-compat)
# ---------------------------------------------------------------------------

def run_auditor_sync(
    project_dir: str, is_yolo: bool = False, max_iterations: int = 10
) -> str:
    """Synchronous wrapper around run_auditor_standalone for CLI/script use."""
    import asyncio as _asyncio
    result = _asyncio.run(
        run_auditor_standalone(project_dir, is_yolo=is_yolo, max_iterations=max_iterations)
    )
    return result.get("report", "")


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python auditor.py <project_dir> [--yolo] [--max-iterations N]")
        sys.exit(1)

    _project_dir = sys.argv[1]
    _is_yolo = "--yolo" in sys.argv
    _max_iterations = 10
    for _i, _arg in enumerate(sys.argv):
        if _arg == "--max-iterations" and _i + 1 < len(sys.argv):
            _max_iterations = int(sys.argv[_i + 1])

    _report = run_auditor_sync(_project_dir, _is_yolo, _max_iterations)
    print(_report)

