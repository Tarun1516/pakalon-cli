"""
graph.py — Phase 2 LangGraph StateGraph: Wireframe + Design Agent.
T107: read_phase1 → check_figma → generate_penpot → open_browser → await_approval → tdd_screenshot → save_outputs
T-CLI-11: Human-in-the-loop wireframe approval before TDD.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
from typing import Any, TypedDict

try:
    from langgraph.graph import StateGraph, END  # type: ignore
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

from ..shared.paths import get_phase_dir, get_wireframes_dir, get_tdd_screenshots_dir
from ..shared.decision_registry import record_decision


class Phase2State(TypedDict, total=False):
    project_dir: str
    user_id: str
    is_yolo: bool
    send_sse: Any
    _input_queue: Any   # asyncio.Queue for approval / HIL input
    phase1_summary: dict
    figma_data: dict | None
    wireframe_spec: dict
    wireframe_svg: str
    user_feedback: str  # T-CLI-P2: Design modification feedback for reflection
    penpot_file_id: str | None  # Penpot file ID for accept-design round-trip polling
    penpot_project_url: str | None  # T-P2-01: browseable Penpot URL
    tdd_result: dict
    chrome_tdd_result: dict          # T-CLI-P2-CHROME: Chrome DevTools MCP TDD results
    browser_opened: bool
    design_approved: bool
    outputs_saved: list[str]

    context_budget: dict | None  # T103: optional ContextBudget.get_all() dict for per-phase max_tokens caps

# ------------------------------------------------------------------
# Nodes
# ------------------------------------------------------------------

async def read_phase1(state: Phase2State) -> Phase2State:
    """Node: Load phase-1 outputs from disk + Mem0."""
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📖 Reading Phase 1 outputs...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    phase1_dir = get_phase_dir(project_dir, 1, create=False)
    summary: dict = {}

    for fname in ("plan.md", "design.md", "technical-spec.md", "phase-1.md"):
        fpath = phase1_dir / fname
        if fpath.exists():
            summary[fname] = fpath.read_text()[:3000]

    # T-A03: Also load Phase 1 context from Mem0
    try:
        from ..shared.mem0_context import retrieve_phase1_context
        user_id = state.get("user_id", "anonymous")
        mem0_context = retrieve_phase1_context(user_id, str(project_dir))
        if mem0_context:
            summary["_mem0_context"] = mem0_context
            sse({"type": "text_delta", "content": "  🧠 Loaded Phase 1 context from memory\n"})
    except Exception:
        pass

    state["phase1_summary"] = summary
    return state
    """Node: Load phase-1 outputs from disk."""
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📖 Reading Phase 1 outputs...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    phase1_dir = get_phase_dir(project_dir, 1, create=False)
    summary: dict = {}

    for fname in ("plan.md", "design.md", "technical-spec.md", "phase-1.md"):
        fpath = phase1_dir / fname
        if fpath.exists():
            summary[fname] = fpath.read_text()[:3000]

    state["phase1_summary"] = summary
    return state


async def check_figma(state: Phase2State) -> Phase2State:
    """Node: Check for Figma export in phase-1 dir; re-import if found."""
    sse = state.get("send_sse") or (lambda e: None)
    project_dir = pathlib.Path(state.get("project_dir", "."))
    figma_path = get_phase_dir(project_dir, 1, create=False) / "figma.json"

    if figma_path.exists():
        sse({"type": "text_delta", "content": "🎨 Loading Figma export from phase-1...\n"})
        try:
            state["figma_data"] = json.loads(figma_path.read_text())
        except Exception:
            state["figma_data"] = None
    else:
        state["figma_data"] = None
    return state


async def generate_penpot(state: Phase2State) -> Phase2State:
    """Node: Generate Penpot wireframe from phase1 design.md + Figma data."""
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🖼  Generating wireframe...\n"})

    phase1 = state.get("phase1_summary", {})
    figma = state.get("figma_data")

    spec: dict = {
        "title": "Phase 2 Wireframe",
        "pages": [],
    }

    # Parse design.md for page structure
    design_md = phase1.get("design.md", "")
    if "# " in design_md:
        lines = design_md.split("\n")
        for line in lines:
            if line.startswith("## "):
                spec["pages"].append({"name": line[3:].strip(), "sections": []})

    if not spec["pages"]:
        spec["pages"] = [
            {"name": "Home", "sections": ["hero", "features", "cta"]},
            {"name": "Dashboard", "sections": ["sidebar", "main-content", "footer"]},
        ]

    if figma:
        spec["figma_reference"] = {"colors": figma.get("colors", []), "fonts": figma.get("fonts", [])}

    # T-CLI-P2: Design Modification Reflection — incorporate user feedback into wireframe
    user_feedback = state.get("user_feedback", "")
    if user_feedback:
        spec["modification_feedback"] = user_feedback
        sse({"type": "text_delta", "content": f"  ✏️  Applying design feedback: {user_feedback[:100]}\n"})

    state["wireframe_spec"] = spec

    # T-CLI-04: Use live Penpot REST API (Docker) with local SVG fallback
    penpot_ok = False
    try:
        # Try relative import first (when running as a package)
        try:
            from ...tools.penpot import PenpotTool as _PT  # type: ignore
        except ImportError:
            import pathlib as _pl
            import sys as _sys
            _root = str(_pl.Path(__file__).resolve().parents[2])
            if _root not in _sys.path:
                _sys.path.insert(0, _root)
            from tools.penpot import PenpotTool as _PT  # type: ignore

        tool = _PT()
        if tool.is_running():
            sse({"type": "text_delta", "content": "  \u2705 Penpot Docker active \u2014 using live API\n"})
            state["wireframe_svg"] = tool.create_wireframe(spec)
            penpot_ok = True
        else:
            sse({"type": "text_delta", "content": "  \U0001f433 Starting Penpot container...\n"})
            started = tool.start_container()
            if started:
                import time
                for _ in range(20):
                    if tool.is_running():
                        break
                    time.sleep(1)
                state["wireframe_svg"] = tool.create_wireframe(spec)
                sse({"type": "text_delta", "content": "  \u2705 Penpot started \u2014 wireframe via live API\n"})
                penpot_ok = True
            else:
                state["wireframe_svg"] = tool._generate_svg_wireframe(spec)
                sse({"type": "text_delta", "content": "  \u26a0\ufe0f Docker unavailable \u2014 SVG fallback used\n"})
        if penpot_ok and tool.last_file_id:
            state["penpot_file_id"] = tool.last_file_id
            # T-P2-01: expose the browseable project URL
            if tool.last_project_url:
                state["penpot_project_url"] = tool.last_project_url
                sse({"type": "text_delta", "content": f"  🌐 View in Penpot: {tool.last_project_url}\n"})
    except Exception as _exc:
        sse({"type": "text_delta", "content": f"  \u26a0\ufe0f Penpot not available ({_exc}) \u2014 using basic SVG\n"})
        from .tdd import WireframeTDD
        state["wireframe_svg"] = WireframeTDD._basic_svg(spec)

    return state


async def open_browser(state: Phase2State) -> Phase2State:
    """
    Node: Open wireframe in default browser for human review.
    T-CLI-04: Prefers the Penpot Docker web UI (localhost:3449) when running.
    Falls back to a local HTML file.
    """
    sse = state.get("send_sse") or (lambda e: None)
    svg = state.get("wireframe_svg", "")
    project_dir = pathlib.Path(state.get("project_dir", "."))
    out_dir = get_phase_dir(project_dir, 2)
    out_dir.mkdir(parents=True, exist_ok=True)

    svg_path = out_dir / "wireframe.svg"
    svg_path.write_text(svg)

    # Wrap SVG in HTML (always written as fallback)
    html = f"<!DOCTYPE html><html><body style='background:#f9fafb;margin:0'>{svg}</body></html>"
    html_path = out_dir / "wireframe.html"
    html_path.write_text(html)

    if not state.get("is_yolo"):
        # T-P2-01: Use the specific file URL if we created one, otherwise generic Penpot UI
        penpot_url: str | None = state.get("penpot_project_url")
        if not penpot_url:
            try:
                try:
                    from ...tools.penpot import PenpotTool as _PT  # type: ignore
                except ImportError:
                    from tools.penpot import PenpotTool as _PT  # type: ignore
                tool = _PT()
                if tool.is_running():
                    penpot_url = "http://localhost:3449"
            except Exception:
                penpot_url = None

        open_target = penpot_url or str(html_path)
        try:
            import subprocess
            import platform
            if platform.system() == "Windows":
                subprocess.Popen(["start", open_target], shell=True)
            elif platform.system() == "Darwin":
                subprocess.Popen(["open", open_target])
            else:
                subprocess.Popen(["xdg-open", open_target])
        except Exception:
            pass

        if penpot_url:
            sse({"type": "text_delta", "content": f"\U0001f310 Penpot UI opened at {penpot_url}\n"})
        else:
            sse({"type": "text_delta", "content": f"\U0001f310 Wireframe saved to {html_path}\n"})

    state["browser_opened"] = True
    return state


async def _poll_penpot_for_edits(
    file_id: str,
    initial_svg: str,
    out_dir: pathlib.Path,
    send_sse: Any = None,
    poll_interval: float = 5.0,
    timeout: float = 300.0,
) -> str | None:
    """
    D-03: Poll Penpot's REST API every `poll_interval` seconds.
    Compares the `revn` (revision number) field from GET /api/rpc/command/get-file
    against the last known revision. On change:
      1. Export updated SVG and overwrite the saved files on disk.
      2. Export updated Penpot JSON and overwrite Wireframe_generated.json.
      3. Emit SSE `design_updated` event.
    Returns the new SVG string if changes detected, or None otherwise.
    """
    _sse = send_sse or (lambda e: None)

    try:
        try:
            from ...tools.penpot import PenpotTool as _PT  # type: ignore
        except ImportError:
            import sys as _sys2, pathlib as _pl2
            _root2 = str(_pl2.Path(__file__).resolve().parents[2])
            if _root2 not in _sys2.path:
                _sys2.path.insert(0, _root2)
            from tools.penpot import PenpotTool as _PT  # type: ignore

        tool = _PT()
        if not tool.is_running():
            return None

        # Use the tool's persistent session for polling (handles cookie auth / token)
        last_revn: int | None = None
        try:
            meta = tool.get_file_meta(file_id)
            last_revn = meta.get("revn") if "error" not in meta else None
        except Exception:
            pass

        elapsed = 0.0

        while elapsed < timeout:
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
            try:
                meta = tool.get_file_meta(file_id)
                if "error" in meta:
                    continue
                current_revn: int | None = meta.get("revn")
                if current_revn is not None and last_revn is not None and current_revn != last_revn:
                    last_revn = current_revn
                    updated_svg = tool.export_svg(file_id)
                    if not updated_svg or updated_svg.startswith("<!-- Export failed"):
                        continue

                    # Overwrite saved SVG files
                    svg_final = out_dir / "wireframe-final.svg"
                    svg_final.write_text(updated_svg)
                    wireframes_dir = out_dir.parent / "wireframes"
                    if wireframes_dir.exists():
                        (wireframes_dir / "wireframe-final.svg").write_text(updated_svg)

                    # Overwrite Penpot JSON
                    updated_json = tool.export_json(file_id)
                    generated_json = out_dir / "Wireframe_generated.json"
                    import json as _json
                    generated_json.write_text(_json.dumps(updated_json, indent=2))
                    if wireframes_dir.exists():
                        (wireframes_dir / "Wireframe_generated.json").write_text(_json.dumps(updated_json, indent=2))

                    files_updated = [
                        str(svg_final),
                        str(generated_json),
                    ]
                    _sse({
                        "type": "design_updated",
                        "message": f"Penpot revision {current_revn}: design synced to disk.",
                        "files_updated": files_updated,
                    })
                    return updated_svg
            except Exception:
                pass  # keep polling

    except Exception:
        pass

    return None


async def await_approval(state: Phase2State) -> Phase2State:
    """
    Node: T-CLI-11 — Ask the user in the terminal to accept or regenerate
    the wireframe. YOLO mode auto-approves.
    Emits an 'approval_request' SSE event and waits on _input_queue.
    """
    sse = state.get("send_sse") or (lambda e: None)
    is_yolo = state.get("is_yolo", False)

    if is_yolo:
        state["design_approved"] = True
        sse({"type": "text_delta", "content": "✅ YOLO mode: wireframe auto-approved.\n"})
        return state

    # ---- Penpot round-trip: poll for user edits in the browser ----
    penpot_file_id = state.get("penpot_file_id")
    if penpot_file_id:
        sse({"type": "text_delta", "content": "⏳ Watching Penpot for design changes (up to 5 min)...\n"})
        project_dir = pathlib.Path(state.get("project_dir", "."))
        out_dir = get_phase_dir(project_dir, 2)
        edited_svg = await _poll_penpot_for_edits(
            file_id=penpot_file_id,
            initial_svg=state.get("wireframe_svg", ""),
            out_dir=out_dir,
            send_sse=sse,
            poll_interval=10.0,
            timeout=300.0,
        )
        if edited_svg:
            state["wireframe_svg"] = edited_svg
            sse({"type": "text_delta", "content": "✏️  Penpot edits detected — synced into agent state.\n"})
            # Show the user their edits and ask for final confirmation
            sse({
                "type": "approval_request",
                "message": "You made changes in Penpot. The updated design has been synced.",
                "question": "Proceed with this edited design?",
                "choices": [
                    {"id": "accept", "label": "✅ Accept edited design"},
                    {"id": "regenerate", "label": "🔄 Discard edits and regenerate"},
                ],
                "svg_preview": edited_svg[:500],
            })
            input_queue: asyncio.Queue | None = state.get("_input_queue")  # type: ignore
            edit_answer = "accept"
            if input_queue is not None:
                try:
                    edit_answer = str(await asyncio.wait_for(input_queue.get(), timeout=120.0))
                except asyncio.TimeoutError:
                    edit_answer = "accept"
            if edit_answer == "regenerate":
                state["wireframe_svg"] = ""
                state["design_approved"] = False
                state = await generate_penpot(state)
                state = await open_browser(state)

    # Emit main approval request event to TUI
    sse({
        "type": "approval_request",
        "message": "Wireframe generated and opened in browser.",
        "question": "Accept this design and proceed to Phase 3?",
        "choices": [
            {"id": "accept", "label": "✅ Accept this design"},
            {"id": "make_changes", "label": "✏️  Make Changes (describe modifications)"},
            {"id": "regenerate", "label": "🔄 Regenerate wireframe from scratch"},
            {"id": "skip", "label": "⏭  Skip and continue"},
        ],
    })

    # Wait for response from TUI via asyncio Queue
    input_queue: asyncio.Queue | None = state.get("_input_queue")   # type: ignore
    answer = "accept"
    if input_queue is not None:
        try:
            answer = str(await asyncio.wait_for(input_queue.get(), timeout=300.0))
        except asyncio.TimeoutError:
            answer = "accept"  # auto-accept on timeout

    if answer == "make_changes":
        # T-CLI-P2: Design Modification Reflection
        # Ask user for their change description via awaiting_input SSE event
        sse({"type": "awaiting_input", "prompt": "Describe the changes you want to the wireframe:"})
        feedback = "improve the design aesthetics"
        if input_queue is not None:
            try:
                feedback = str(await asyncio.wait_for(input_queue.get(), timeout=300.0))
            except asyncio.TimeoutError:
                pass
        sse({"type": "text_delta", "content": f"✏️  Regenerating wireframe with feedback: {feedback}\n"})
        state["user_feedback"] = feedback
        state["design_approved"] = False
        state = await generate_penpot(state)
        state = await open_browser(state)
        sse({"type": "text_delta", "content": "✅ Proceeding with updated wireframe.\n"})
        state["design_approved"] = True

    elif answer == "regenerate":
        sse({"type": "text_delta", "content": "🔄 Regenerating wireframe from scratch...\n"})
        state["design_approved"] = False
        state["user_feedback"] = ""
        state = await generate_penpot(state)
        state = await open_browser(state)
        sse({"type": "text_delta", "content": "✅ Proceeding with regenerated wireframe.\n"})
        state["design_approved"] = True

    else:
        state["design_approved"] = True
        sse({"type": "text_delta", "content": "✅ Design approved.\n"})

    return state


async def tdd_screenshot(state: Phase2State) -> Phase2State:
    """
    Node: Screenshot the wireframe HTML and run TDD comparison (T-CLI-P2-TDD).
    If the TDD loop ends without passing the threshold:
      - YOLO mode: automatically regenerates once with the failure feedback injected.
      - HIL mode: emits a choice_request so the user can decide to fix or continue.
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📸 Running wireframe screenshot TDD...\n"})

    from .tdd import WireframeTDD
    tdd_runner = WireframeTDD()

    async def _run_tdd(spec: dict, max_iter: int) -> dict:
        return await tdd_runner.run_tdd_loop(
            wireframe_spec=spec,
            reference_path=None,
            max_iterations=max_iter,
            send_sse=sse,
        )

    result = await _run_tdd(state.get("wireframe_spec", {}), max_iterations=3)
    state["tdd_result"] = result
    if result.get("svg"):
        state["wireframe_svg"] = result["svg"]

    compare = result.get("compare_result", {})
    passed = compare.get("passed", True)
    similarity = compare.get("similarity", 1.0)

    if passed:
        sse({"type": "text_delta", "content": f"✅ Wireframe TDD passed ({similarity:.0%} similarity).\n"})
        return state

    # --- TDD failed: surface failure ---
    issues = compare.get("missing_elements", []) + compare.get("suggestions", [])
    issue_summary = "\n".join(f"  • {i}" for i in issues[:5]) if issues else "  • Low similarity to reference design."
    sse({"type": "text_delta", "content": f"⚠️  Wireframe TDD: {similarity:.0%} similarity (below threshold).\n{issue_summary}\n"})

    is_yolo = state.get("is_yolo", False)

    if is_yolo:
        # YOLO: auto-regenerate once with failure feedback
        sse({"type": "text_delta", "content": "🔄 YOLO: auto-regenerating wireframe with TDD feedback...\n"})
        feedback_prompt = tdd_runner.generate_iteration_prompt(compare)
        updated_spec = dict(state.get("wireframe_spec", {}))
        updated_spec["_tdd_feedback"] = feedback_prompt
        state["wireframe_spec"] = updated_spec
        state = await generate_penpot(state)  # regenerate with feedback injected
        retry_result = await _run_tdd(state.get("wireframe_spec", {}), max_iterations=2)
        state["tdd_result"] = retry_result
        if retry_result.get("svg"):
            state["wireframe_svg"] = retry_result["svg"]
        retry_passed = retry_result.get("compare_result", {}).get("passed", True)
        retry_sim = retry_result.get("compare_result", {}).get("similarity", 1.0)
        sse({
            "type": "text_delta",
            "content": f"{'✅' if retry_passed else '⚠️'} Retry TDD: {retry_sim:.0%} similarity.\n",
        })
    else:
        # HIL: ask user whether to fix or continue
        sse({
            "type": "choice_request",
            "prompt": (
                f"Wireframe TDD fidelity is only {similarity:.0%}. What would you like to do?"
            ),
            "choices": [
                {"id": "fix", "label": "🔄 Regenerate wireframe (apply TDD feedback)"},
                {"id": "continue", "label": "⏭  Continue with current wireframe"},
            ],
        })
        input_queue: asyncio.Queue | None = state.get("_input_queue")  # type: ignore
        answer = "continue"
        if input_queue is not None:
            try:
                answer = str(await asyncio.wait_for(input_queue.get(), timeout=120.0))
            except asyncio.TimeoutError:
                answer = "continue"

        if answer.strip().lower() in ("fix", "0"):
            feedback_prompt = tdd_runner.generate_iteration_prompt(compare)
            updated_spec = dict(state.get("wireframe_spec", {}))
            updated_spec["_tdd_feedback"] = feedback_prompt
            state["wireframe_spec"] = updated_spec
            sse({"type": "text_delta", "content": "🔄 Regenerating wireframe with TDD feedback...\n"})
            state = await generate_penpot(state)
            retry_result = await _run_tdd(state.get("wireframe_spec", {}), max_iterations=3)
            state["tdd_result"] = retry_result
            if retry_result.get("svg"):
                state["wireframe_svg"] = retry_result["svg"]
            retry_sim = retry_result.get("compare_result", {}).get("similarity", 1.0)
            sse({"type": "text_delta", "content": f"✅ Retry TDD: {retry_sim:.0%} similarity.\n"})
        else:
            sse({"type": "text_delta", "content": "⏭  Continuing with current wireframe.\n"})

    return state


async def chrome_mcp_verify(state: Phase2State) -> Phase2State:
    """
    Node: T-CLI-P2-CHROME — Use ChromeDevToolsMCP (Playwright) to open the
    generated wireframe in a real browser, take a screenshot, compare it
    against the design requirements from phase1_summary, and optionally
    collect human feedback in HIL mode.

    Saves screenshots to:
      <project_dir>/.pakalon-agents/ai-agents/phase-2/tdd-screenshots/
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🌐 Chrome DevTools MCP: opening wireframe for visual TDD...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    screenshots_dir = get_tdd_screenshots_dir(project_dir, 2)
    screenshots_dir.mkdir(parents=True, exist_ok=True)

    wireframe_html = get_phase_dir(project_dir, 2, create=False) / "wireframe.html"
    wireframe_url = wireframe_html.as_uri()  # file:///...

    chrome_result: dict = {
        "opened": False,
        "screenshot_path": None,
        "design_issues": [],
        "passed": True,
        "error": None,
    }

    try:
        # ---- dynamic import: try package-relative then sys.path ----
        try:
            from ...phase3.chrome_mcp import ChromeDevToolsMCP  # type: ignore
        except ImportError:
            import sys as _sys
            import pathlib as _pl
            _parent = str(_pl.Path(__file__).resolve().parents[1])
            if _parent not in _sys.path:
                _sys.path.insert(0, _parent)
            from phase3.chrome_mcp import ChromeDevToolsMCP  # type: ignore  # noqa: PLC0415

        chrome = ChromeDevToolsMCP(playwright_headless=True)
        connected = await chrome.connect()
        if not connected:
            sse({"type": "text_delta", "content": "  ⚠️  Chrome DevTools MCP unavailable — skipping visual TDD\n"})
            chrome_result["error"] = "ChromeDevToolsMCP could not connect"
            state["chrome_tdd_result"] = chrome_result
            return state

        chrome_result["opened"] = True
        sse({"type": "text_delta", "content": f"  🌍 Navigating to: {wireframe_url}\n"})

        await chrome.navigate(wireframe_url)
        await asyncio.sleep(1.5)  # let renders settle

        # ─── Take page screenshot ───
        timestamp = int(asyncio.get_event_loop().time())
        shot_path = screenshots_dir / f"wireframe-chrome-{timestamp}.png"
        shot_b64 = await chrome.screenshot(full_page=True)
        if shot_b64:
            import base64 as _b64
            shot_path.write_bytes(_b64.b64decode(shot_b64))
            chrome_result["screenshot_path"] = str(shot_path)
            sse({"type": "text_delta", "content": f"  📸 Screenshot saved: {shot_path.name}\n"})

        # ─── Console log check: surface any JS errors ───
        console_logs = chrome.get_console_logs() if hasattr(chrome, "get_console_logs") else []
        js_errors = [e for e in console_logs if e.get("type") in ("error", "warning")]
        if js_errors:
            chrome_result["design_issues"].extend(
                [f"JS {e['type'].upper()}: {e.get('text', '')[:120]}" for e in js_errors[:10]]
            )

        # ─── AI-driven design comparison vs phase1 design.md ───
        design_md = state.get("phase1_summary", {}).get("design.md", "")
        if shot_b64 and design_md:
            api_key = os.environ.get("OPENROUTER_API_KEY", "")
            if api_key:
                try:
                    import httpx as _httpx
                    payload = {
                        "model": "google/gemini-flash-1.5",
                        "max_tokens": min(512, state.get("context_budget", {}).get("phase2") or 512) if state.get("context_budget") else 512,
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "text",
                                        "text": (
                                            "You are a UX QA reviewer.\n"
                                            "Compare this wireframe screenshot to the design requirements below.\n"
                                            "List up to 5 specific issues as a JSON array of strings (empty array if none).\n\n"
                                            f"DESIGN REQUIREMENTS:\n{design_md[:1500]}\n\n"
                                            "Respond ONLY with a JSON array, e.g.: [\"Issue 1\", \"Issue 2\"] or []"
                                        ),
                                    },
                                    {
                                        "type": "image_url",
                                        "image_url": {"url": f"data:image/png;base64,{shot_b64}"},
                                    },
                                ],
                            }
                        ],
                    }
                    async with _httpx.AsyncClient(timeout=30) as client:
                        resp = await client.post(
                            "https://openrouter.ai/api/v1/chat/completions",
                            headers={"Authorization": f"Bearer {api_key}"},
                            json=payload,
                        )
                    raw = resp.json()["choices"][0]["message"]["content"].strip()
                    # parse JSON array from response
                    start = raw.find("[")
                    end = raw.rfind("]") + 1
                    if start != -1 and end > start:
                        issues = json.loads(raw[start:end])
                        chrome_result["design_issues"].extend(issues)
                except Exception as _ai_err:
                    chrome_result["design_issues"].append(f"AI comparison unavailable: {_ai_err}")

        chrome_result["passed"] = len(chrome_result["design_issues"]) == 0

        # ─── Emit TDD result event ───
        sse({
            "type": "tdd_result",
            "phase": 2,
            "passed": chrome_result["passed"],
            "issues": chrome_result["design_issues"],
            "screenshot": str(shot_path) if chrome_result["screenshot_path"] else None,
        })

        if chrome_result["design_issues"]:
            issue_lines = "\n".join(f"  • {i}" for i in chrome_result["design_issues"])
            sse({"type": "text_delta", "content": f"  ⚠️  Design issues found:\n{issue_lines}\n"})
        else:
            sse({"type": "text_delta", "content": "  ✅ Wireframe matches design requirements.\n"})

        # ─── HIL feedback loop (skip in YOLO mode) ───
        if not state.get("is_yolo") and chrome_result["design_issues"]:
            sse({
                "type": "awaiting_input",
                "prompt": (
                    "Chrome visual TDD found design issues. "
                    "Type 'fix' to regenerate the wireframe addressing these issues, "
                    "or press Enter to continue anyway:"
                ),
            })
            input_queue: asyncio.Queue | None = state.get("_input_queue")  # type: ignore
            answer = ""
            if input_queue is not None:
                try:
                    answer = str(await asyncio.wait_for(input_queue.get(), timeout=120.0))
                except asyncio.TimeoutError:
                    answer = ""

            if answer.strip().lower() == "fix":
                sse({"type": "text_delta", "content": "🔄 Fixing design issues and regenerating wireframe...\n"})
                fix_feedback = "Fix the following design issues:\n" + "\n".join(
                    f"- {i}" for i in chrome_result["design_issues"]
                )
                state["user_feedback"] = fix_feedback
                state["design_approved"] = False
                state = await generate_penpot(state)
                state = await open_browser(state)
                # Recurse once to re-verify after fix
                state = await chrome_mcp_verify(state)
                return state

        await chrome.disconnect()

    except Exception as _e:
        sse({"type": "text_delta", "content": f"  ⚠️  Chrome MCP verify error: {_e}\n"})
        chrome_result["error"] = str(_e)

    state["chrome_tdd_result"] = chrome_result
    return state


async def agent_browser_snapshot(state: Phase2State) -> Phase2State:
    """
    Node: T-P2-09/12/13 — Use AgentBrowser to capture an accessibility tree
    snapshot and baseline screenshot from the generated wireframe HTML file.

    Stores accessibility node count in state["tdd_result"]["agent_browser"]
    and saves wireframe-baseline.png to the wireframes directory.
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🤖 AgentBrowser: capturing wireframe accessibility snapshot...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    wireframe_html = get_phase_dir(project_dir, 2, create=False) / "wireframe.html"

    # Fall back to inline SVG in a temp file if the HTML hasn't been written yet
    wireframe_url: str | None = None
    _tmp_html: str | None = None
    if wireframe_html.exists():
        wireframe_url = wireframe_html.as_uri()
    else:
        svg = state.get("wireframe_svg", "")
        if svg:
            import tempfile as _tmpf
            with _tmpf.NamedTemporaryFile(
                suffix=".html", delete=False, mode="w", encoding="utf-8"
            ) as _tf:
                _tf.write(
                    f"<!DOCTYPE html><html><body style='background:#f9fafb;margin:0'>{svg}</body></html>"
                )
                _tmp_html = _tf.name
            wireframe_url = pathlib.Path(_tmp_html).as_uri()

    ab_result: dict = {}
    if wireframe_url:
        try:
            from ..phase3.agent_browser import AgentBrowser  # type: ignore
            ab = AgentBrowser(project_dir=str(project_dir))

            # T-P2-12: Accessibility tree extraction
            snap = await ab.snapshot(wireframe_url)
            node_count = len(snap.get("nodes", [])) if isinstance(snap, dict) else 0
            ab_result["node_count"] = node_count
            sse({"type": "text_delta", "content": f"  🌳 Accessibility tree: {node_count} nodes\n"})

            # T-P2-13: Baseline screenshot for visual drift tracking
            baseline_ss = await ab.screenshot(wireframe_url)
            baseline_path = baseline_ss.get("path") if isinstance(baseline_ss, dict) else None
            if baseline_path:
                import shutil as _sh
                wf_dir = get_wireframes_dir(project_dir)
                wf_dir.mkdir(parents=True, exist_ok=True)
                _dest = wf_dir / "wireframe-baseline.png"
                _sh.copy2(baseline_path, _dest)
                ab_result["baseline_screenshot"] = str(_dest)
                sse({"type": "text_delta", "content": f"  📸 Baseline → wireframes/wireframe-baseline.png\n"})

        except Exception as _ab_err:
            ab_result["skipped"] = str(_ab_err)
            sse({"type": "text_delta", "content": f"  AgentBrowser snapshot skipped: {_ab_err}\n"})
    else:
        ab_result["skipped"] = "No wireframe HTML or SVG available"
        sse({"type": "text_delta", "content": "  AgentBrowser snapshot skipped: no wireframe content\n"})

    # Clean up temp file
    if _tmp_html:
        try:
            import os as _os
            _os.unlink(_tmp_html)
        except Exception:
            pass

    # Merge into tdd_result
    tdd = dict(state.get("tdd_result") or {})
    tdd["agent_browser"] = ab_result
    state["tdd_result"] = tdd
    return state


async def save_outputs(state: Phase2State) -> Phase2State:
    """Node: Save all phase-2 outputs to disk — SVG + JSON wireframe."""
    sse = state.get("send_sse") or (lambda e: None)
    project_dir = pathlib.Path(state.get("project_dir", "."))
    out_dir = get_phase_dir(project_dir, 2)
    out_dir.mkdir(parents=True, exist_ok=True)

    saved: list[str] = []

    # Final wireframe SVG
    svg_path = out_dir / "wireframe-final.svg"
    svg_path.write_text(state.get("wireframe_svg", ""))
    saved.append(str(svg_path))

    # Canonical required artifact name (spec compatibility)
    generated_svg_path = out_dir / "Wireframe_generated.svg"
    generated_svg_path.write_text(state.get("wireframe_svg", ""))
    saved.append(str(generated_svg_path))

    # T-CLI-P2: JSON wireframe export (in addition to SVG)
    wireframe_spec = state.get("wireframe_spec", {})
    json_path = out_dir / "wireframe.json"
    json_path.write_text(json.dumps(wireframe_spec, indent=2))
    saved.append(str(json_path))
    sse({"type": "text_delta", "content": f"  💾 JSON wireframe saved: {json_path}\n"})

    # D-02: Export Penpot file JSON via REST and save as Wireframe_generated.json
    penpot_file_id = state.get("penpot_file_id")
    generated_json_path = out_dir / "Wireframe_generated.json"
    generated_json_written = False
    if penpot_file_id:
        try:
            try:
                from ...tools.penpot import PenpotTool as _PT  # type: ignore
            except ImportError:
                import sys as _sys, pathlib as _pl
                _root = str(_pl.Path(__file__).resolve().parents[2])
                if _root not in _sys.path:
                    _sys.path.insert(0, _root)
                from tools.penpot import PenpotTool as _PT  # type: ignore
            _penpot = _PT()
            if _penpot.is_running():
                penpot_export = _penpot.export_json(penpot_file_id)
                generated_json_path.write_text(json.dumps(penpot_export, indent=2))
                saved.append(str(generated_json_path))
                generated_json_written = True
                sse({"type": "text_delta", "content": f"  🎨 Penpot JSON exported: {generated_json_path}\n"})
        except Exception as _pex:
            sse({"type": "text_delta", "content": f"  ⚠️ Penpot JSON export skipped: {_pex}\n"})

    # Always guarantee Wireframe_generated.json even without Penpot export
    if not generated_json_written:
        generated_json_path.write_text(json.dumps(wireframe_spec, indent=2))
        saved.append(str(generated_json_path))
        sse({"type": "text_delta", "content": f"  💾 Canonical JSON wireframe saved: {generated_json_path}\n"})

    # Copy both SVG and JSON to wireframes/ for Phase 3 access
    wireframes_dir = project_dir / "wireframes"
    wireframes_dir.mkdir(parents=True, exist_ok=True)
    for src in [svg_path, json_path, generated_svg_path, generated_json_path]:
        dst = wireframes_dir / src.name
        import shutil
        shutil.copy2(str(src), str(dst))
    sse({"type": "text_delta", "content": f"  📁 Copied outputs to wireframes/\n"})

    # TDD results
    tdd_path = out_dir / "tdd-results.json"
    tdd_path.write_text(json.dumps(state.get("tdd_result", {}), indent=2))
    saved.append(str(tdd_path))

    # Chrome DevTools MCP TDD results
    chrome_result = state.get("chrome_tdd_result", {})
    if chrome_result:
        chrome_path = out_dir / "chrome-tdd-results.json"
        chrome_path.write_text(json.dumps(chrome_result, indent=2))
        saved.append(str(chrome_path))
        sse({"type": "text_delta", "content": f"  💾 Chrome TDD results saved: {chrome_path}\n"})

    # Phase-2 summary markdown
    summary_path = out_dir / "phase-2.md"
    tdd = state.get("tdd_result", {})
    summary_path.write_text(
        f"# Phase 2: Wireframe Design\n\n"
        f"## Status\n\nCompleted.\n\n"
        f"## TDD Results\n\n"
        f"- Similarity: {tdd.get('compare_result', {}).get('similarity', 'N/A')}\n"
        f"- Iterations: {tdd.get('iterations_run', 1)}\n\n"
        f"## Chrome DevTools Visual TDD\n\n"
        + (
            f"- Passed: {chrome_result.get('passed', 'N/A')}\n"
            f"- Issues: {len(chrome_result.get('design_issues', []))}\n"
            + ((
                "- Design Issues:\n"
                + "".join(f"  - {i}\n" for i in chrome_result.get("design_issues", []))
            ) if chrome_result.get("design_issues") else "")
            + f"- Screenshot: `{pathlib.Path(chrome_result['screenshot_path']).name}`\n"
              if chrome_result.get('screenshot_path') else ""
        )
        + f"\n## Outputs\n\n"
        f"- `wireframe-final.svg` — SVG wireframe\n"
        f"- `Wireframe_generated.svg` — Canonical generated SVG wireframe\n"
        f"- `wireframe.json` — JSON wireframe spec\n"
        f"- `Wireframe_generated.json` — Canonical generated JSON wireframe\n"
        f"- `tdd-results.json` — TDD comparison results\n"
        f"- `chrome-tdd-results.json` — Chrome DevTools MCP visual TDD results\n"
        + "\n".join(f"- `{pathlib.Path(p).name}`" for p in saved)
    )
    saved.append(str(summary_path))

    state["outputs_saved"] = saved

    # Record phase-2 completion in cross-phase decision registry
    tdd_sim = state.get("tdd_result", {}).get("compare_result", {}).get("similarity", "N/A")
    record_decision(
        str(project_dir),
        phase=2,
        decision_type="phase_output",
        description=f"Phase 2 wireframe design complete — TDD similarity: {tdd_sim}",
        source_file="phase-2/phase-2.md",
        metadata={"outputs": saved, "penpot_file_id": state.get("penpot_file_id")},
    )

    # ── Cloud storage upload (MinIO / Cloudinary) ──────────────────────────
    # Upload the key wireframe artifacts so they're accessible via URL.
    # Skipped silently when no storage credentials are configured.
    try:
        from ...tools.storage import StorageTool as _ST  # type: ignore
    except ImportError:
        try:
            import sys as _sys3, pathlib as _pl3
            _root3 = str(_pl3.Path(__file__).resolve().parents[2])
            if _root3 not in _sys3.path:
                _sys3.path.insert(0, _root3)
            from tools.storage import StorageTool as _ST  # type: ignore  # noqa: PLC0415
        except ImportError:
            _ST = None  # type: ignore

    if _ST is not None:
        _storage = _ST()
        _project_slug = project_dir.name.replace(" ", "-").lower()
        _cloud_urls: dict[str, str] = {}
        _upload_targets = [
            (svg_path, f"wireframes/{_project_slug}/wireframe-final.svg"),
            (generated_svg_path, f"wireframes/{_project_slug}/Wireframe_generated.svg"),
            (generated_json_path, f"wireframes/{_project_slug}/Wireframe_generated.json"),
        ]
        # Also upload any Chrome TDD screenshots found in the screenshots dir
        _screenshots_dir = out_dir / "tdd-screenshots"
        if _screenshots_dir.exists():
            for _shot in sorted(_screenshots_dir.glob("*.png"))[-3:]:  # latest 3
                _upload_targets.append((_shot, f"wireframes/{_project_slug}/screenshots/{_shot.name}"))

        for _filepath, _remote_key in _upload_targets:
            if not _filepath.exists():
                continue
            try:
                _result = _storage.upload(str(_filepath), remote_key=_remote_key, public=True)
                if _result.get("success"):
                    _cloud_urls[_filepath.name] = _result["url"]
                    sse({"type": "text_delta", "content": f"  ☁️  Uploaded {_filepath.name} → {_result['url']}\n"})
            except Exception as _upload_err:
                sse({"type": "text_delta", "content": f"  ⚠️  Storage upload skipped for {_filepath.name}: {_upload_err}\n"})

        if _cloud_urls:
            state["cloud_artifact_urls"] = _cloud_urls
            # Write URL manifest to disk for downstream phases
            _url_manifest = out_dir / "cloud-urls.json"
            _url_manifest.write_text(json.dumps(_cloud_urls, indent=2))
            saved.append(str(_url_manifest))

    # T-P3-02: Save penpot_project_url to url-manifest.json for Phase 3 disk fallback
    _url_manifest_path = out_dir / "url-manifest.json"
    _url_manifest_data = {
        "penpot_project_url": state.get("penpot_project_url"),
        "penpot_file_id": state.get("penpot_file_id"),
        "penpot_file_url": (
            f"{os.environ.get('PENPOT_BASE_URL', 'http://localhost:3449')}/view/{state.get('penpot_file_id')}"
            if state.get("penpot_file_id") else None
        ),
    }
    _url_manifest_path.write_text(json.dumps(_url_manifest_data, indent=2))
    saved.append(str(_url_manifest_path))

    sse({"type": "phase_complete", "phase": 2, "files": [str(s) for s in saved]})
    return state


# ------------------------------------------------------------------
# Graph assembly
# ------------------------------------------------------------------

def build_phase2_graph() -> Any:
    if not LANGGRAPH_AVAILABLE:
        return None
    graph = StateGraph(Phase2State)
    graph.add_node("read_phase1", read_phase1)
    graph.add_node("check_figma", check_figma)
    graph.add_node("generate_penpot", generate_penpot)
    graph.add_node("open_browser", open_browser)
    graph.add_node("await_approval", await_approval)
    graph.add_node("tdd_screenshot", tdd_screenshot)
    graph.add_node("chrome_mcp_verify", chrome_mcp_verify)
    graph.add_node("agent_browser_snapshot", agent_browser_snapshot)
    graph.add_node("save_outputs", save_outputs)
    graph.set_entry_point("read_phase1")
    graph.add_edge("read_phase1", "check_figma")
    graph.add_edge("check_figma", "generate_penpot")
    graph.add_edge("generate_penpot", "open_browser")
    graph.add_edge("open_browser", "await_approval")
    graph.add_edge("await_approval", "tdd_screenshot")
    graph.add_edge("tdd_screenshot", "chrome_mcp_verify")
    graph.add_edge("chrome_mcp_verify", "agent_browser_snapshot")
    graph.add_edge("agent_browser_snapshot", "save_outputs")
    graph.add_edge("save_outputs", END)
    try:
        from ..shared.langgraph_checkpointer import build_checkpointer  # noqa: PLC0415
        _ckpt = build_checkpointer()
    except Exception:
        _ckpt = None
    return graph.compile(checkpointer=_ckpt) if _ckpt is not None else graph.compile()


async def run_phase2(
    project_dir: str,
    user_id: str = "anonymous",
    is_yolo: bool = False,
    send_sse: Any = None,
    input_queue: Any = None,
    context_budget: "dict | None" = None,  # T103: ContextBudget.get_all() dict
) -> dict[str, Any]:
    _sse = send_sse or (lambda e: None)
    # T-CLI-26: Read Phase 1 Mem0 context for continuity
    try:
        from ..shared.mem0_context import retrieve_phase1_context  # noqa: PLC0415
        _mem0_ctx = retrieve_phase1_context(user_id, project_dir)
    except Exception:
        _mem0_ctx = ""
    initial: Phase2State = {
        "project_dir": project_dir,
        "user_id": user_id,
        "is_yolo": is_yolo,
        "send_sse": _sse,
        "_input_queue": input_queue,  # type: ignore
        "_mem0_context": _mem0_ctx,  # type: ignore
        "context_budget": context_budget,
    }
    graph = build_phase2_graph()
    if graph is None:
        state: Any = initial
        for node_fn in [read_phase1, check_figma, generate_penpot, open_browser, await_approval, tdd_screenshot, chrome_mcp_verify, save_outputs]:
            state = await node_fn(state)
    else:
        try:
            from ..shared.langgraph_checkpointer import thread_config as _tc2  # noqa: PLC0415
            _cfg2 = _tc2(user_id, project_dir, phase=2)
        except Exception:
            _cfg2 = {}
        state = await graph.ainvoke(initial, config=_cfg2)
    # T-RAG-01C: store Phase 2 summary in Mem0
    try:
        from ..shared.langgraph_checkpointer import store_phase_mem0  # noqa: PLC0415
        _p2_outs = ", ".join(str(o) for o in state.get("outputs_saved", [])[:5])
        store_phase_mem0(user_id, project_dir, phase=2, summary=f"Wireframe outputs: {_p2_outs}")
    except Exception:
        pass
    return {
        "status": "complete",
        "outputs_saved": state.get("outputs_saved", []),
        "penpot_project_url": state.get("penpot_project_url"),  # T-P3-02
        "wireframe_svg": state.get("wireframe_svg", ""),  # T-P3-01
    }
