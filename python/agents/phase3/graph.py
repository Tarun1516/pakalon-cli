"""
graph.py — Phase 3 LangGraph StateGraph: Code Implementation Agent.
T112: 5 sub-agents running in sequence:
  SA1: frontend-design   — scaffold file/folder structure + generate UI components
  SA2: backend-frame     — implement API routes, DB schema, auth module
  SA3: integration-wiring— wire env vars, docker-compose, imports, config
  SA4: debugging-testing — lint/typecheck auto-fix loop, Chrome MCP browser testing + recording
  SA5: user-feedback     — HIL gate: confirm, request changes (re-runs SA1-SA4), or skip Phase 4
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

from .execution_log import ExecutionLog
from ..shared.paths import get_phase_dir, get_test_evidence_dir
from ..shared.decision_registry import record_decision
from ..skills import load_skill, get_frontend_skills
from .auditor import run_auditor as run_auditor_node


class Phase3State(TypedDict, total=False):
    project_dir: str
    user_id: str
    is_yolo: bool
    send_sse: Any
    _input_queue: Any  # asyncio.Queue for HIL confirm/changes input
    execution_log: Any  # ExecutionLog instance
    phase1_summary: dict
    phase2_summary: dict
    wireframe_svg: str  # T-P3-01: SVG wireframe from Phase 2, injected into SA1
    penpot_project_url: str | None  # T-P3-02: Penpot URL for component reference
    scaffolded_files: list[str]
    component_files: list[str]
    logic_files: list[str]
    integration_files: list[str]
    validation_results: dict
    outputs_saved: list[str]
    retry_patch_plan: dict | None  # T-CLI-23: targeted retry issues from Phase 4
    context_budget: dict | None  # T103: optional ContextBudget.get_all() dict for per-phase max_tokens caps
    # Auditor Agent state
    auditor_result: dict | None  # Last completed audit report dict
    auditor_iteration: int  # Number of completed auditor iterations
    auditor_max_iterations: int  # Max iterations (user-set in HIL, 10 in YOLO)


# ------------------------------------------------------------------
# LLM helper
# ------------------------------------------------------------------

# T103: Module-level budget cap — set by run_phase3() when context_budget is provided.
_phase_budget_cap: int | None = None

async def _llm(messages: list[dict], max_tokens: int = 4096, _budget_cap: int | None = None) -> str:
    effective_cap = _budget_cap or _phase_budget_cap
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        return "// [No OPENROUTER_API_KEY — placeholder code]"
    try:
        import httpx
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": os.environ.get("PAKALON_MODEL", "anthropic/claude-3-5-haiku"),
                    "messages": messages,
                    "max_tokens": min(max_tokens, effective_cap) if effective_cap else max_tokens,
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f"// [LLM error: {e}]"


def _load_phase_summary(project_dir: str, phase: int) -> dict:
    p = get_phase_dir(project_dir, phase, create=False)
    result: dict = {}
    if p.exists():
        for f in p.glob("*.md"):
            result[f.name] = f.read_text()[:2000]
    return result


# ------------------------------------------------------------------
# Terminal execution helper
# ------------------------------------------------------------------

async def _run_terminal_command(
    cmd: list[str],
    cwd: str,
    log: "ExecutionLog",
    sse: Any,
    label: str,
    timeout: int = 120,
) -> dict:
    """
    Run a terminal command asynchronously, stream stdout/stderr as SSE text_delta
    events, log with ExecutionLog, and return {returncode, stdout, stderr, error}.
    T-CLI-P3: Used for npx, npm, pip, bun, cargo etc. package installations.
    """
    result: dict = {"returncode": -1, "stdout": "", "stderr": "", "error": None}
    sse({"type": "text_delta", "content": f"  $ {' '.join(cmd)}\n"})
    log.log_command(label, cmd)  # type: ignore[attr-defined]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        async def _stream(stream: asyncio.StreamReader, store: list[str], prefix: str) -> None:
            async for raw_line in stream:
                line = raw_line.decode("utf-8", errors="replace").rstrip()
                store.append(line)
                sse({"type": "text_delta", "content": f"    {prefix}{line}\n"})

        try:
            await asyncio.wait_for(
                asyncio.gather(
                    _stream(proc.stdout, stdout_lines, ""),  # type: ignore[arg-type]
                    _stream(proc.stderr, stderr_lines, "⚠ "),  # type: ignore[arg-type]
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            result["error"] = f"Timeout after {timeout}s"
            sse({"type": "text_delta", "content": f"  ⏱ {label} timed out after {timeout}s\n"})

        returncode = await proc.wait()
        result["returncode"] = returncode
        result["stdout"] = "\n".join(stdout_lines)
        result["stderr"] = "\n".join(stderr_lines)
        status = "✅" if returncode == 0 else "❌"
        sse({"type": "text_delta", "content": f"  {status} {label} exited {returncode}\n"})
        log.log_command_result(label, returncode, result["stdout"][:500])  # type: ignore[attr-defined]

    except FileNotFoundError:
        result["error"] = f"{cmd[0]} not found"
        sse({"type": "text_delta", "content": f"  ⚠ {cmd[0]} not found — skipping\n"})
    except Exception as _e:
        result["error"] = str(_e)
        sse({"type": "text_delta", "content": f"  ❌ {label} error: {_e}\n"})

    return result


async def _detect_and_install_packages(
    project_dir: pathlib.Path,
    log: "ExecutionLog",
    sse: Any,
    tech_spec: str = "",
    plan: str = "",
) -> list[dict]:
    """
    T-CLI-P3: Detect package manifests in project_dir and run the appropriate
    install commands.  Also bootstraps the project with 'npx create-next-app'
    or similar scaffolders if detected from tech_spec/plan and no package.json exists.

    Returns list of command results.
    """
    sse({"type": "text_delta", "content": "📦 SA1: Installing dependencies...\n"})
    results: list[dict] = []
    cwd = str(project_dir)

    # ---- Bootstrap phase: npx create-next-app / vite / CRA / others ----
    lower_spec = (tech_spec + " " + plan).lower()
    pkg_json = project_dir / "package.json"

    if not pkg_json.exists():
        if "next.js" in lower_spec or "nextjs" in lower_spec or "next js" in lower_spec:
            sse({"type": "text_delta", "content": "  🚀 Bootstrapping Next.js app...\n"})
            r = await _run_terminal_command(
                ["npx", "--yes", "create-next-app@latest", ".", "--typescript", "--tailwind",
                 "--eslint", "--app", "--no-git", "--no-import-alias"],
                cwd=cwd, log=log, sse=sse, label="npx:create-next-app",
            )
            results.append(r)
        elif "vite" in lower_spec:
            sse({"type": "text_delta", "content": "  ⚡ Bootstrapping Vite app...\n"})
            r = await _run_terminal_command(
                ["npx", "--yes", "create-vite@latest", ".", "--template", "react-ts"],
                cwd=cwd, log=log, sse=sse, label="npx:create-vite",
            )
            results.append(r)
        elif "remix" in lower_spec:
            r = await _run_terminal_command(
                ["npx", "--yes", "create-remix@latest", ".", "--typescript"],
                cwd=cwd, log=log, sse=sse, label="npx:create-remix",
            )
            results.append(r)
        elif "express" in lower_spec or "node" in lower_spec:
            # just init a package.json
            r = await _run_terminal_command(
                ["npm", "init", "-y"],
                cwd=cwd, log=log, sse=sse, label="npm:init",
            )
            results.append(r)

    # ---- Shadcn/ui init if Next.js + shadcn detected ----
    if pkg_json.exists() and ("shadcn" in lower_spec or "shadcn/ui" in lower_spec):
        r = await _run_terminal_command(
            ["npx", "--yes", "shadcn-ui@latest", "init", "--yes"],
            cwd=cwd, log=log, sse=sse, label="npx:shadcn-init", timeout=60,
        )
        results.append(r)

    # ---- T-P3-14: TanStack Query — install when React/Next.js/Vite detected ----
    is_react_app = (
        pkg_json.exists()
        and (
            "next.js" in lower_spec or "nextjs" in lower_spec or "next js" in lower_spec
            or "react" in lower_spec or "vite" in lower_spec or "remix" in lower_spec
        )
    )
    if is_react_app:
        sse({"type": "text_delta", "content": "  ⚛️  Installing @tanstack/react-query...\n"})
        r = await _run_terminal_command(
            ["npm", "install", "@tanstack/react-query", "@tanstack/react-query-devtools",
             "--save", "--legacy-peer-deps"],
            cwd=cwd, log=log, sse=sse, label="npm:tanstack-query",
        )
        results.append(r)

    # ---- npm / bun install ----
    if pkg_json.exists():
        # Prefer bun if available
        prefer_bun = "bun" in lower_spec
        try:
            import subprocess as _sp
            _sp.run(["bun", "--version"], capture_output=True, check=True, timeout=5)
            prefer_bun = True
        except Exception:
            prefer_bun = False

        if prefer_bun:
            r = await _run_terminal_command(
                ["bun", "install"], cwd=cwd, log=log, sse=sse, label="bun:install",
            )
        else:
            r = await _run_terminal_command(
                ["npm", "install", "--legacy-peer-deps"],
                cwd=cwd, log=log, sse=sse, label="npm:install",
            )
        results.append(r)

    # ---- pip / pip3 install ----
    req_txt = project_dir / "requirements.txt"
    req_dev = project_dir / "requirements-dev.txt"
    pyproj = project_dir / "pyproject.toml"

    # Determine pip executable (prefer venv)
    pip_exec = "pip"
    venv_pip = project_dir / "venv" / "bin" / "pip"
    if venv_pip.exists():
        pip_exec = str(venv_pip)

    if req_txt.exists():
        r = await _run_terminal_command(
            [pip_exec, "install", "-r", str(req_txt), "--quiet"],
            cwd=cwd, log=log, sse=sse, label="pip:install-requirements",
        )
        results.append(r)
    if req_dev.exists():
        r = await _run_terminal_command(
            [pip_exec, "install", "-r", str(req_dev), "--quiet"],
            cwd=cwd, log=log, sse=sse, label="pip:install-requirements-dev",
        )
        results.append(r)
    if pyproj.exists() and not req_txt.exists():
        # Try pip install -e .
        r = await _run_terminal_command(
            [pip_exec, "install", "-e", ".", "--quiet"],
            cwd=cwd, log=log, sse=sse, label="pip:install-editable",
        )
        results.append(r)

    # ---- Cargo (Rust) ----
    cargo_toml = project_dir / "Cargo.toml"
    if cargo_toml.exists():
        r = await _run_terminal_command(
            ["cargo", "build"], cwd=cwd, log=log, sse=sse, label="cargo:build", timeout=180,
        )
        results.append(r)

    # ---- go mod ----
    go_mod = project_dir / "go.mod"
    if go_mod.exists():
        r = await _run_terminal_command(
            ["go", "mod", "download"], cwd=cwd, log=log, sse=sse, label="go:mod-download",
        )
        results.append(r)

    ok = sum(1 for r in results if r.get("returncode") == 0)
    sse({"type": "text_delta", "content": f"  📦 {ok}/{len(results)} install commands succeeded\n"})
    return results


# ------------------------------------------------------------------
# SA1: Frontend Design (UI scaffold from wireframe + components)
# ------------------------------------------------------------------

async def sa1_frontend_design(state: Phase3State) -> Phase3State:
    sse = state.get("send_sse") or (lambda e: None)
    log: ExecutionLog = state["execution_log"]
    log.log_start("SA1:FrontendDesign", "Scaffold project structure and implement UI components from wireframe")
    sse({"type": "text_delta", "content": "🎨 SA1: Frontend Design — scaffolding project structure from wireframe...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    plan = state.get("phase1_summary", {}).get("plan.md", "")
    retry_patch_plan = state.get("retry_patch_plan")

    # T-P3-01: wireframe context for scaffold structure
    wireframe_svg_brief = ""
    _wf_svg = state.get("wireframe_svg", "")
    if _wf_svg:
        wireframe_svg_brief = f"\n\nWireframe reference (SVG — use to infer component hierarchy):\n```svg\n{_wf_svg[:1500]}\n```"

    created: list[str] = []

    # Generate structure from plan.md
    retry_context = ""
    if retry_patch_plan:
        retry_context = (
            "\n\nPhase 4 retry context (targeted patch mode):\n"
            + json.dumps(retry_patch_plan, indent=2)[:3000]
            + "\n\nIMPORTANT: This is a retry run. Prioritize patching existing affected files/issues from retry context"
              " instead of broad scaffolding. Only create new files when strictly required to fix listed issues."
        )

    structure_prompt = f"""Based on this plan:\n\n{plan[:2000]}{wireframe_svg_brief}{retry_context}\n\nGenerate the directory structure and empty files to create.
Return JSON: {{"dirs": ["src/", "src/components/", ...], "files": {{"src/index.ts": "// entry point", ...}}}}
Return ONLY JSON."""

    raw = await _llm([{"role": "user", "content": structure_prompt}], max_tokens=2000)

    try:
        import re
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        structure = json.loads(match.group()) if match else {}
    except Exception:
        structure = {}

    # Create dirs
    for d in structure.get("dirs", []):
        path = project_dir / d
        path.mkdir(parents=True, exist_ok=True)

    # Create stub files
    for rel_path, content in structure.get("files", {}).items():
        path = project_dir / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(str(content))
            created.append(str(path))
            log.log_file_created("SA1:Scaffold", str(path))

    state["scaffolded_files"] = created
    log.log_end("SA1:Scaffold", f"Created {len(created)} files")

    log.log_command(
        "SA1:FrontendDesign",  # type: ignore[attr-defined]
        ["install-dependencies"],
    )
    install_results = await _detect_and_install_packages(
        project_dir=project_dir,
        log=log,
        sse=sse,
        tech_spec=state.get("phase1_summary", {}).get("technical-spec.md", ""),
        plan=state.get("phase1_summary", {}).get("plan.md", ""),
    )
    log.log(
        "SA1:FrontendDesign",
        f"Package installs: {sum(1 for r in install_results if r.get('returncode') == 0)}/{len(install_results)} succeeded",
        status="success" if all(r.get("returncode") == 0 for r in install_results) else "warning",
    )

    # ── Load Frontend Design Skill for component generation ──
    _skill_ctx = _load_skill_context("frontend-design")

    # ── Phase 1b: Generate UI components from wireframe (still SA1 scope per requirements) ──
    sse({"type": "text_delta", "content": "🧩 SA1: Implementing UI components from wireframe...\n"})
    design_md = state.get("phase1_summary", {}).get("design.md", "")
    # Search registry for needed components
    try:
        from .registry_rag import RegistryRAG
        _rag = RegistryRAG()
        _rag.load()
        _components = _rag.search(design_md[:500], top_k=5)
        _registry_ctx = json.dumps(_components, indent=2)[:1000]
    except Exception:
        _registry_ctx = "[]"
    # Scrape reference component URLs
    _scraped_ctx = ""
    try:
        import re as _re_comp
        import httpx as _hx_comp
        _BRIDGE = os.environ.get("BRIDGE_URL", "http://127.0.0.1:9001")
        _ref_urls = [u for u in _re_comp.findall(r"https?://[^\s\"'>]+", design_md) if any(kw in u for kw in ["component", "ui", "shadcn", "tailwind"])][:2]
        if not _ref_urls:
            _ref_urls = ["https://ui.shadcn.com/docs/components/button", "https://tailwindui.com/components/marketing/sections/heroes"]
        _scraped_parts: list[str] = []
        async with _hx_comp.AsyncClient(timeout=20) as _hxc:
            for _url in _ref_urls[:2]:
                try:
                    _r = await _hxc.post(f"{_BRIDGE}/scrape", json={"url": _url})
                    if _r.status_code == 200:
                        _t = (_r.json().get("content") or _r.json().get("markdown") or "")
                        if _t:
                            _scraped_parts.append(f"--- {_url} ---\n{_t[:600]}")
                except Exception:
                    pass
        if _scraped_parts:
            _scraped_ctx = "\n\n".join(_scraped_parts)
            sse({"type": "text_delta", "content": f"  🌐 Scraped {len(_scraped_parts)} component reference(s)\n"})
    except Exception:
        pass

    # Load frontend design skills
    _skills_ctx = ""
    try:
        _frontend_skill = load_skill("frontend-design")
        if _frontend_skill:
            _skills_ctx = f"\n\n## FRONTEND DESIGN SKILL\n\n{_frontend_skill[:2000]}\n"
    except Exception:
        pass

    # T-P3-01: Inject Phase 2 wireframe SVG context into component generation
    wireframe_svg_ctx = state.get("wireframe_svg", "")
    wireframe_ctx_str = ""
    if wireframe_svg_ctx:
        wireframe_ctx_str = (
            "\n\n## Wireframe Design (from Phase 2)\n\n"
            "The following SVG represents the approved wireframe. Implement components that faithfully "
            "replicate the layout, sections, and UI elements shown:\n\n"
            f"```svg\n{wireframe_svg_ctx[:3000]}\n```\n"
        )

    # T-P3-02: Include Penpot project URL so developers can open the design
    penpot_url = state.get("penpot_project_url")
    penpot_ctx_str = ""
    if penpot_url:
        penpot_ctx_str = f"\n\n## Penpot Design Reference\n\nInteractive wireframe: {penpot_url}\n"

    _comp_prompt = (
        f"Based on this design:\n\n{design_md[:1000]}\n"
        + wireframe_ctx_str
        + penpot_ctx_str
        + (_skills_ctx if _skills_ctx else "")
        + f"Registry components:\n{_registry_ctx}\n"
        + (f"Web reference:\n{_scraped_ctx[:800]}\n" if _scraped_ctx else "")
        + "Generate a Navbar, Hero, and Footer React component.\n"
        + "IMPORTANT: Follow the Frontend Design Skill guidelines and wireframe above for distinctive aesthetics.\n"
        + "T-P3-14 REQUIREMENT: For ALL async data fetching, use @tanstack/react-query hooks "
          "(useQuery, useMutation, useInfiniteQuery). Never use raw fetch/axios/useEffect for data "
          "fetching. Wrap app root with QueryClient + QueryClientProvider. Include "
          "@tanstack/react-query-devtools in development builds.\n"
        + "Return JSON array: [{\"path\": \"src/components/Navbar.tsx\", \"content\": \"...\"}]"
    )
    _comp_raw = await _llm([{"role": "user", "content": _comp_prompt}], max_tokens=4000)
    component_files: list[str] = []
    try:
        import re as _re_c2
        _cm = _re_c2.search(r"\[.*\]", _comp_raw, _re_c2.DOTALL)
        for _cf in (json.loads(_cm.group()) if _cm else []):
            _cp = project_dir / _cf.get("path", "src/components/Component.tsx")
            _cp.parent.mkdir(parents=True, exist_ok=True)
            _cp.write_text(_cf.get("content", ""))
            component_files.append(str(_cp))
            log.log_file_created("SA1:FrontendDesign", str(_cp))
    except Exception:
        pass
    state["component_files"] = component_files
    sse({"type": "text_delta", "content": f"  🎨 {len(component_files)} component files generated\n"})

    # T-P3-14: Write QueryClientProvider bootstrap wrapper for React/Next.js apps
    _pkg_json_path = project_dir / "package.json"
    _lower_plan = (state.get("phase1_summary", {}).get("plan.md", "") + " " + design_md).lower()
    _is_react = _pkg_json_path.exists() and any(
        kw in _lower_plan for kw in ["react", "next.js", "nextjs", "next js", "vite", "remix"]
    )
    if _is_react:
        _qc_path = project_dir / "src" / "providers" / "QueryProvider.tsx"
        _qc_path.parent.mkdir(parents=True, exist_ok=True)
        if not _qc_path.exists():
            _qc_path.write_text(
                '"use client";\n\n'
                'import { QueryClient, QueryClientProvider } from "@tanstack/react-query";\n'
                'import { ReactQueryDevtools } from "@tanstack/react-query-devtools";\n'
                'import { ReactNode, useState } from "react";\n\n'
                'export function QueryProvider({ children }: { children: ReactNode }) {\n'
                '  const [client] = useState(\n'
                '    () =>\n'
                '      new QueryClient({\n'
                '        defaultOptions: {\n'
                '          queries: {\n'
                '            staleTime: 60 * 1000,\n'
                '            retry: 1,\n'
                '          },\n'
                '        },\n'
                '      })\n'
                '  );\n'
                '  return (\n'
                '    <QueryClientProvider client={client}>\n'
                '      {children}\n'
                '      {process.env.NODE_ENV === "development" && (\n'
                '        <ReactQueryDevtools initialIsOpen={false} />\n'
                '      )}\n'
                '    </QueryClientProvider>\n'
                '  );\n'
                '}\n'
            )
            component_files.append(str(_qc_path))
            log.log_file_created("SA1:TanStackQuery", str(_qc_path))
            sse({"type": "text_delta", "content": "  ⚛️  QueryProvider.tsx written for @tanstack/react-query\n"})

    log.log_end("SA1:FrontendDesign", f"Scaffold: {len(created)} files | Components: {len(component_files)} files")

    # Write subagent-1.md
    out_dir = get_phase_dir(project_dir, 3)
    out_dir.mkdir(parents=True, exist_ok=True)
    all_frontend_files = created + component_files
    (out_dir / "subagent-1.md").write_text(
        f"# Subagent 1: Frontend Design\n\n"
        f"## Role\nUI scaffold from wireframe + React component implementation + dependency install\n\n"
        f"## Status: Complete\n\n"
        f"## Scaffold Files ({len(created)})\n\n"
        + "\n".join(f"- `{f}`" for f in created[:30])
        + f"\n\n## Component Files ({len(component_files)})\n\n"
        + "\n".join(f"- `{f}`" for f in component_files[:30])
    )
    return state


# ------------------------------------------------------------------
# SA2: Backend Frame (API routes, DB schema, server logic)
# ------------------------------------------------------------------

async def sa2_backend_frame(state: Phase3State) -> Phase3State:
    sse = state.get("send_sse") or (lambda e: None)
    log: ExecutionLog = state["execution_log"]
    log.log_start("SA2:BackendFrame", "Implement API routes, DB schema, and server-side business logic")
    sse({"type": "text_delta", "content": "⚙️  SA2: Backend Frame — implementing API routes and DB schema...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    tech_spec = state.get("phase1_summary", {}).get("technical-spec.md", "")
    retry_patch_plan = state.get("retry_patch_plan")

    # T-P1-16 / T-P1-17: Read API_reference.md + Database_schema.md from Phase 1 before first LLM call
    p1_summary = state.get("phase1_summary", {})
    api_ref_md    = p1_summary.get("API_reference.md", "")
    db_schema_md  = p1_summary.get("Database_schema.md", "")
    # Also try loading directly from disk if not in state (cross-phase resilience)
    if not api_ref_md or not db_schema_md:
        phase1_dir = get_phase_dir(state.get("project_dir", "."), 1, create=False)
        if not api_ref_md:
            _f = phase1_dir / "API_reference.md"
            if _f.exists():
                api_ref_md = _f.read_text()[:3000]
        if not db_schema_md:
            _f = phase1_dir / "Database_schema.md"
            if _f.exists():
                db_schema_md = _f.read_text()[:3000]

    api_context = ""
    if api_ref_md:
        api_context = f"\n\n## API Reference (from Phase 1 planning)\n{api_ref_md[:2000]}"
    db_context = ""
    if db_schema_md:
        db_context = f"\n\n## Database Schema (from Phase 1 planning)\n{db_schema_md[:2000]}"

    retry_context = ""
    if retry_patch_plan:
        retry_context = (
            "\n\nPhase 4 retry context (targeted patch mode):\n"
            + json.dumps(retry_patch_plan, indent=2)[:3000]
            + "\n\nIMPORTANT: This is a retry run. Focus on patching listed backend/security/requirement issues first."
        )

    prompt = f"""Based on this technical spec:\n\n{tech_spec[:1500]}{api_context}{db_context}{retry_context}\n\nGenerate:
1. A database schema file (models.py or schema.prisma) — MUST match the schema spec above exactly
2. An API routes file (routes.py or api/routes.ts) — MUST implement all endpoints from API reference above
3. An authentication module (auth.py or auth/index.ts)
Return JSON array: [{{"path": "...", "content": "..."}}]"""

    raw = await _llm([{"role": "user", "content": prompt}], max_tokens=4000)

    created: list[str] = []
    try:
        import re
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        files = json.loads(match.group()) if match else []
        for f in files:
            path = project_dir / f.get("path", "src/routes.ts")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f.get("content", ""))
            created.append(str(path))
            log.log_file_created("SA2:BackendFrame", str(path))
    except Exception:
        pass

    # Database schema generation
    sse({"type": "text_delta", "content": "🗄️  SA2: Generating database schema and migrations...\n"})
    db_files: list[str] = []
    if any(kw in tech_spec.lower() for kw in ["postgresql", "postgres", "mysql", "sqlite", "database", "db"]):
        db_prompt = (
            f"Based on this technical spec:\n\n{tech_spec[:1500]}\n\n"
            "Generate a complete database migration file with SQL CREATE TABLE statements "
            "and a corresponding ORM schema (Prisma/SQLAlchemy/Drizzle).\n"
            "Return JSON array: [{\"path\": \"...\", \"content\": \"...\"}]"
        )
        db_raw = await _llm([{"role": "user", "content": db_prompt}], max_tokens=3000)
        try:
            import re as _re_db
            m = _re_db.search(r"\[.*\]", db_raw, _re_db.DOTALL)
            for f in (json.loads(m.group()) if m else []):
                p = project_dir / f.get("path", "db/schema.sql")
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(f.get("content", ""))
                db_files.append(str(p))
                log.log_file_created("SA2:BackendFrame:DB", str(p))
        except Exception:
            pass
        sse({"type": "text_delta", "content": f"  Database: {len(db_files)} schema files created\n"})

    state["logic_files"] = created
    log.log_end("SA2:BackendFrame", f"API files: {len(created)} | DB files: {len(db_files)}")

    # Write subagent-2.md
    out_dir = get_phase_dir(project_dir, 3)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "subagent-2.md").write_text(
        f"# Subagent 2: Backend Frame\n\n"
        f"## Role\nAPI routes, DB schema, authentication, server-side business logic\n\n"
        f"## Status: Complete\n\n"
        f"## API / Logic Files ({len(created)})\n\n"
        + "\n".join(f"- `{f}`" for f in created[:30])
        + f"\n\n## Database Files ({len(db_files)})\n\n"
        + "\n".join(f"- `{f}`" for f in db_files)
    )
    return state


# ------------------------------------------------------------------
# SA3: Integration Wiring (env, docker, fullstack wiring)
# ------------------------------------------------------------------

async def sa3_integration_wiring(state: Phase3State) -> Phase3State:
    sse = state.get("send_sse") or (lambda e: None)
    log: ExecutionLog = state["execution_log"]
    log.log_start("SA3:IntegrationWiring", "Wire frontend+backend: env, Docker, imports, config")
    sse({"type": "text_delta", "content": "🔌 SA3: Integration Wiring — connecting frontend + backend (env, Docker, imports)...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    plan = state.get("phase1_summary", {}).get("plan.md", "")

    # Create .env.example
    env_path = project_dir / ".env.example"
    if not env_path.exists():
        env_content = "# Auto-generated by Pakalon Phase 3\nDATABASE_URL=postgresql://user:pass@localhost:5432/db\nSECRET_KEY=your-secret-key\nOPENROUTER_API_KEY=\n"
        env_path.write_text(env_content)
        log.log_file_created("SA3:IntegrationWiring", str(env_path))

    # Create docker-compose.yml if PostgreSQL mentioned
    created: list[str] = [str(env_path)]
    if "postgresql" in plan.lower() or "postgres" in plan.lower():
        dc_path = project_dir / "docker-compose.yml"
        if not dc_path.exists():
            dc_content = """version: '3.9'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: db
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
volumes:
  pgdata:
"""
            dc_path.write_text(dc_content)
            log.log_file_created("SA3:IntegrationWiring", str(dc_path))
            created.append(str(dc_path))

    state["integration_files"] = created
    log.log_end("SA3:IntegrationWiring", f"Created {len(created)} integration files")

    # Write subagent-3.md
    out_dir = get_phase_dir(project_dir, 3)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "subagent-3.md").write_text(
        f"# Subagent 3: Integration Wiring\n\n"
        f"## Role\nWire frontend + backend: env setup, Docker compose, import paths, config\n\n"
        f"## Status: Complete\n\n"
        f"## Integration Files ({len(created)})\n\n"
        + "\n".join(f"- `{f}`" for f in created)
    )
    return state


# ------------------------------------------------------------------
# SA4: Debugging & Testing (linting, Chrome MCP, screen recording)
# ------------------------------------------------------------------

async def sa4_debugging_testing(state: Phase3State) -> Phase3State:
    sse = state.get("send_sse") or (lambda e: None)
    log: ExecutionLog = state["execution_log"]
    log.log_start("SA4:DebuggingTesting", "Lint + typecheck auto-fix loop, Chrome MCP browser testing, screen recording")
    sse({"type": "text_delta", "content": "🔧 SA4: Debugging & Testing — running lint, auto-fix loop, and browser validation...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    import subprocess
    import re as _re

    MAX_LINT_ITERATIONS = 5

    def _run_linters(proj: pathlib.Path) -> dict:
        """Run tsc + eslint, return results dict."""
        r: dict = {"linters": [], "typecheck": [], "errors": []}
        if (proj / "tsconfig.json").exists():
            try:
                out = subprocess.run(
                    ["npx", "tsc", "--noEmit"],
                    cwd=str(proj), capture_output=True, text=True, timeout=60,
                )
                r["typecheck"] = out.stderr.splitlines()[:30]
            except Exception as e:
                r["errors"].append(f"tsc: {e}")
        eslint_cfgs = list(proj.glob(".eslint*"))
        if eslint_cfgs:
            try:
                out = subprocess.run(
                    ["npx", "eslint", "src/", "--ext", ".ts,.tsx", "--max-warnings", "30"],
                    cwd=str(proj), capture_output=True, text=True, timeout=60,
                )
                r["linters"] = out.stdout.splitlines()[:30]
            except Exception as e:
                r["errors"].append(f"eslint: {e}")
        return r

    results: dict = {"linters": [], "typecheck": [], "errors": []}

    for lint_iter in range(1, MAX_LINT_ITERATIONS + 1):
        sse({"type": "text_delta", "content": f"  🔬 SA4 lint pass {lint_iter}/{MAX_LINT_ITERATIONS}...\n"})
        results = _run_linters(project_dir)

        has_errors = bool(results.get("typecheck") or results.get("linters"))
        if not has_errors:
            sse({"type": "text_delta", "content": f"  ✅ Code clean after {lint_iter} pass(es).\n"})
            break

        if lint_iter >= MAX_LINT_ITERATIONS:
            sse({"type": "text_delta", "content": f"  ⚠️  {lint_iter} passes done — some lint errors remain.\n"})
            break

        # Ask LLM to generate fixes
        error_lines = results.get("typecheck", []) + results.get("linters", [])
        error_text = "\n".join(error_lines[:60])
        sse({"type": "text_delta", "content": f"  🤖 Asking LLM to fix {len(error_lines)} lint errors...\n"})
        fix_prompt = (
            f"Fix these TypeScript/ESLint errors:\n\n{error_text[:3000]}\n\n"
            "Return ONLY a JSON array of: [{\"path\": \"src/...\", \"content\": \"full fixed file content\"}]"
        )
        fix_raw = await _llm([{"role": "user", "content": fix_prompt}], max_tokens=3000)
        json_match = _re.search(r"\[.*\]", fix_raw, _re.DOTALL)
        if json_match:
            try:
                fixes = json.loads(json_match.group())
                for fix in fixes:
                    rel_path = fix.get("path", "")
                    content = fix.get("content", "")
                    if rel_path and content:
                        fp = project_dir / rel_path
                        if fp.exists() or fp.parent.exists():
                            fp.parent.mkdir(parents=True, exist_ok=True)
                            fp.write_text(content)
                            sse({"type": "text_delta", "content": f"    Fixed: {rel_path}\n"})
            except Exception as parse_err:
                sse({"type": "text_delta", "content": f"    Fix parse error: {parse_err}\n"})

    # Log summary
    log.log("SA4:DebuggingTesting", "Validation complete", json.dumps(results, indent=2), status="info")
    state["validation_results"] = results

    # T-CLI-13: Chrome DevTools MCP dynamic browser testing with screen recording
    chrome_results: dict = {}
    sse({"type": "text_delta", "content": "🌐 SA4: Running Chrome DevTools browser validation (screenshot + recording)...\n"})
    try:
        from .chrome_mcp import ChromeDevToolsMCP
        import base64 as _b64_chrome
        # Create test-evidence directory per requirements
        test_evidence_dir = get_test_evidence_dir(project_dir, create=True)
        cdp = ChromeDevToolsMCP(playwright_headless=True, record_video=True)
        connected = await cdp.connect()
        if connected:
            # Navigate to local dev server if running
            nav = await cdp.navigate("http://localhost:3000")
            title = await cdp.get_page_title()
            screenshot_b64 = await cdp.screenshot(full_page=False)
            accessibility = await cdp.get_accessibility_tree()
            chrome_results = {
                "connected": True,
                "nav_status": nav.get("status"),
                "page_title": title,
                "has_screenshot": bool(screenshot_b64),
                "accessibility_summary": str(accessibility)[:500] if accessibility else "",
            }
            # Save screenshot to test-evidence/
            if screenshot_b64:
                ss_path = test_evidence_dir / "sa4-browser-validation.png"
                ss_path.write_bytes(_b64_chrome.b64decode(screenshot_b64))
                chrome_results["screenshot_path"] = str(ss_path)
                log.log_file_created("SA4:ChromeMCP", str(ss_path))
                sse({"type": "text_delta", "content": f"  📸 Screenshot → test-evidence/sa4-browser-validation.png\n"})
            sse({"type": "text_delta", "content": f"  Browser: {title or 'no title'} — {nav.get('status', 'N/A')}\n"})
            # Record a short video walkthrough
            try:
                import tempfile as _tmpf
                vid_out = str(test_evidence_dir / "sa4-screen-recording.webm")
                vid_path = await cdp.capture_recording(
                    url="http://localhost:3000",
                    duration_s=8.0,
                    output_path=vid_out,
                )
                if vid_path:
                    chrome_results["recording_path"] = vid_path
                    log.log_file_created("SA4:ChromeMCP", vid_path)
                    sse({"type": "text_delta", "content": "  🎬 Screen recording → test-evidence/sa4-screen-recording.webm\n"})
            except Exception as _vid_err:
                sse({"type": "text_delta", "content": f"  Recording skipped: {_vid_err}\n"})
        else:
            chrome_results = {"connected": False, "reason": "No local dev server found at localhost:3000"}
            sse({"type": "text_delta", "content": "  Browser: dev server not running, skipping\n"})
        await cdp.disconnect()
    except Exception as chrome_err:
        chrome_results = {"connected": False, "error": str(chrome_err)}
        sse({"type": "text_delta", "content": f"  Browser validation skipped: {chrome_err}\n"})

    results["chrome_mcp"] = chrome_results

    # T-CLI-P15: Vercel Agent Browser Alignment
    # Compare live localhost:3000 screenshot against phase-2 wireframe using vision model.
    vercel_tdd_result: dict = {}
    if chrome_results.get("connected") and chrome_results.get("screenshot_path"):
        sse({"type": "text_delta", "content": "🔍 SA4: Vercel browser alignment check (wireframe vs live)...\n"})
        try:
            import base64 as _b64
            # Load live app screenshot
            live_ss_path = pathlib.Path(chrome_results["screenshot_path"])
            live_b64 = _b64.b64encode(live_ss_path.read_bytes()).decode()

            # Try to find Phase 2 wireframe PNG
            wireframe_b64: str | None = None
            for wf_candidate in [
                project_dir / ".pakalon-agents" / "ai-agents" / "phase-2" / "wireframe.png",
                project_dir / ".pakalon-agents" / "ai-agents" / "phase-2" / "tdd-screenshots" / "wireframe.png",
            ]:
                if wf_candidate.exists():
                    wireframe_b64 = _b64.b64encode(wf_candidate.read_bytes()).decode()
                    break

            # Also load design.md for context
            design_md_text = ""
            for dm_candidate in [
                project_dir / ".pakalon-agents" / "ai-agents" / "phase-1" / "design.md",
            ]:
                if dm_candidate.exists():
                    design_md_text = dm_candidate.read_text()[:2000]
                    break

            api_key = os.environ.get("OPENROUTER_API_KEY", "")
            if api_key:
                # Build vision comparison prompt
                images_b64 = [live_b64]
                if wireframe_b64:
                    images_b64 = [wireframe_b64, live_b64]
                prompt_text = (
                    "You are a UI/UX QA engineer comparing a wireframe design against a live web application.\n\n"
                    + (f"Design spec:\n{design_md_text}\n\n" if design_md_text else "")
                    + ("Compare: [Image 1 = wireframe] [Image 2 = live app]\n\n" if wireframe_b64 else "Evaluate the live app screenshot:\n\n")
                    + "Respond with JSON: {\"match\": true/false, \"score\": 0-100, \"issues\": [\"...\"], \"suggestions\": [\"...\"]}"
                )
                import httpx as _httpx
                content: list[dict] = [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}}
                    for b in images_b64
                ]
                content.append({"type": "text", "text": prompt_text})
                resp = _httpx.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": os.environ.get("PAKALON_VISION_MODEL", "google/gemini-flash-1.5-8b"),
                        "messages": [{"role": "user", "content": content}],
                        "max_tokens": 512,
                    },
                    timeout=40,
                )
                if resp.status_code == 200:
                    raw_text = resp.json()["choices"][0]["message"]["content"]
                    import re as _re2
                    m = _re2.search(r"\{.*\}", raw_text, _re2.DOTALL)
                    if m:
                        try:
                            vercel_tdd_result = json.loads(m.group())
                        except Exception:
                            vercel_tdd_result = {"raw": raw_text}
                    else:
                        vercel_tdd_result = {"raw": raw_text}
                else:
                    vercel_tdd_result = {"error": f"Vision API HTTP {resp.status_code}"}
            else:
                vercel_tdd_result = {"skipped": "No OPENROUTER_API_KEY for vision comparison"}

            # Save result
            tdd_out = project_dir / ".pakalon-agents" / "ai-agents" / "phase-3"
            tdd_out.mkdir(parents=True, exist_ok=True)
            (tdd_out / "vercel-tdd-result.json").write_text(json.dumps(vercel_tdd_result, indent=2))
            log.log_file_created("SA4:VercelTDD", str(tdd_out / "vercel-tdd-result.json"))

            score = vercel_tdd_result.get("score", "N/A")
            match_str = "✅ Match" if vercel_tdd_result.get("match") else "⚠️  Mismatch"
            sse({"type": "vercel_tdd_result", "data": vercel_tdd_result})
            sse({"type": "text_delta", "content": f"  {match_str} — alignment score: {score}/100\n"})

            issues = vercel_tdd_result.get("issues", [])
            if issues:
                sse({"type": "text_delta", "content": f"  Issues found:\n" + "".join(f"    - {i}\n" for i in issues[:5])})

        except Exception as vtdd_err:
            vercel_tdd_result = {"error": str(vtdd_err)}
            sse({"type": "text_delta", "content": f"  Vercel TDD check failed: {vtdd_err}\n"})

    results["vercel_tdd"] = vercel_tdd_result

    # Save phase-3.md summary
    out_dir = get_phase_dir(project_dir, 3)
    out_dir.mkdir(parents=True, exist_ok=True)
    all_files = (
        state.get("scaffolded_files", [])
        + state.get("component_files", [])
        + state.get("logic_files", [])
        + state.get("integration_files", [])
    )
    _vt = results.get("vercel_tdd", {})
    _vt_line = (
        f"Score: {_vt.get('score', 'N/A')}/100  Match: {_vt.get('match', 'N/A')}"
        if _vt and not _vt.get("error") and not _vt.get("skipped")
        else (_vt.get("skipped") or _vt.get("error") or "Not run")
    )
    summary = f"""# Phase 3: Code Implementation

## Sub-Agent Summary

| Agent | Files Created |
|-------|--------------|
| SA1 Frontend Design | {len(state.get('scaffolded_files', []))} |
| SA2 Backend Frame | {len(state.get('component_files', []))} |
| SA3 Integration Wiring | {len(state.get('logic_files', []))} |
| SA4 Debugging & Testing | {len(state.get('integration_files', []))} |

## Total Files: {len(all_files)}

## Validation
```
{json.dumps(results, indent=2)[:1000]}
```

## Vercel Browser Alignment (T-CLI-P15)
{_vt_line}
"""
    (out_dir / "phase-3.md").write_text(summary)
    log.log_file_created("SA4:DebuggingTesting", str(out_dir / "phase-3.md"))

    # Write subagent-5.md
    (out_dir / "subagent-5.md").write_text(
        f"# Subagent 5: User Feedback\n\n"
        f"## Status: Complete\n\n"
        f"## TypeCheck Results\n\n"
        + ("No errors.\n" if not results.get("typecheck") else "```\n" + "\n".join(results["typecheck"]) + "\n```\n")
        + f"\n## Chrome DevTools\n\n"
        + ("Connected: " + str(chrome_results.get("connected")) + "\n")
        + (f"Page: {chrome_results.get('page_title', 'N/A')}\n" if chrome_results.get("connected") else "Dev server not running.\n")
        + f"\n## Vercel Browser Alignment (T-CLI-P15)\n\n"
        + (_vt_line + "\n")
        + (("\n**Issues:**\n" + "\n".join(f"- {i}" for i in (_vt.get("issues") or []))) if _vt.get("issues") else "")
        + (("\n**Suggestions:**\n" + "\n".join(f"- {s}" for s in (_vt.get("suggestions") or []))) if _vt.get("suggestions") else "")
    )

    state["outputs_saved"] = all_files + [str(out_dir / "phase-3.md")]

    # Record implementation decisions in cross-phase registry
    record_decision(
        str(state.get("project_dir", ".")),
        phase=3,
        decision_type="phase_output",
        description=f"Phase 3 implementation complete — {len(all_files)} files generated",
        source_file="phase-3/phase-3.md",
        metadata={"file_count": len(all_files)},
    )

    log.log_end("SA4:DebuggingTesting", "Debugging & Testing complete — handing off to SA5 User Feedback")
    return state


async def sa5_user_feedback(state: Phase3State) -> Phase3State:
    """SA5: User Feedback — HIL choice gate (Confirm / Make Changes / Skip QA) with re-run loop."""
    sse = state.get("send_sse") or (lambda e: None)
    log: ExecutionLog = state["execution_log"]
    log.log_start("SA5:UserFeedback", "HIL confirmation gate — confirm, request changes, or skip Phase 4")
    sse({"type": "text_delta", "content": "\ud83d\udcac SA5: User Feedback \u2014 awaiting your confirmation...\n"})

    all_files = (
        state.get("scaffolded_files", [])
        + state.get("component_files", [])
        + state.get("logic_files", [])
        + state.get("integration_files", [])
    )

    # T-CLI-P3: Confirm/Make Changes HIL button
    is_yolo = state.get("is_yolo", False)
    if not is_yolo:
        sse({
            "type": "choice_request",
            "message": f"Phase 3 complete. {len(all_files)} files generated.",
            "question": "How would you like to proceed?",
            "choices": [
                {"id": "confirm", "label": "\u2705 Confirm \u2014 proceed to Phase 4 (Security QA)"},
                {"id": "changes", "label": "\u270f\ufe0f  Make Changes \u2014 provide instructions to adjust"},
                {"id": "skip_qa", "label": "\u23ed  Skip to Phase 5 (CI/CD)"},
            ],
        })

        input_queue: asyncio.Queue | None = state.get("_input_queue")  # type: ignore
        answer = "confirm"
        if input_queue is not None:
            try:
                answer = str(await asyncio.wait_for(input_queue.get(), timeout=300.0))
            except asyncio.TimeoutError:
                answer = "confirm"

        if answer == "changes":
            # T-CLI-19: SA5 HIL feedback loop — collect change instructions, then re-apply SA1–SA4.
            sse({"type": "awaiting_input", "prompt": "Describe the changes you want (files, features, fixes):"})
            change_instructions = ""
            if input_queue is not None:
                try:
                    change_instructions = str(await asyncio.wait_for(input_queue.get(), timeout=600.0))
                except asyncio.TimeoutError:
                    change_instructions = ""

            if change_instructions:
                sse({"type": "text_delta", "content": f"\n\ud83d\udd04 Applying your changes: {change_instructions[:200]}\n"})
                # Re-run SA1–SA4 with amended context so changed files are regenerated.
                amended_state = dict(state)
                # Append change request to phase1 plan so sub-agents see it
                existing_plan = amended_state.get("phase1_summary", {}).get("plan.md", "")
                amended_state["phase1_summary"] = {
                    **amended_state.get("phase1_summary", {}),
                    "plan.md": existing_plan + f"\n\n## User Change Request\n{change_instructions}",
                }
                for retry_fn in [sa1_frontend_design, sa2_backend_frame, sa3_integration_wiring, sa4_debugging_testing]:
                    amended_state = await retry_fn(amended_state)  # type: ignore
                # Merge updated file lists back into current state
                state["scaffolded_files"] = amended_state.get("scaffolded_files", state.get("scaffolded_files", []))
                state["component_files"] = amended_state.get("component_files", state.get("component_files", []))
                state["logic_files"] = amended_state.get("logic_files", state.get("logic_files", []))
                state["integration_files"] = amended_state.get("integration_files", state.get("integration_files", []))
                state["validation_results"] = amended_state.get("validation_results", state.get("validation_results", {}))
                sse({"type": "text_delta", "content": "  \u2705 Changes applied \u2014 proceeding to Phase 4.\n"})
            else:
                sse({"type": "text_delta", "content": "  No changes provided \u2014 proceeding with current code.\n"})
        elif answer == "skip_qa":
            sse({"type": "text_delta", "content": "\u23ed  Skipping Phase 4 \u2014 proceeding directly to Phase 5.\n"})
            state["skip_phase4"] = True

    # ── Cloud storage upload (MinIO / Cloudinary) ──────────────────────────
    # Upload browser screenshots and screen recordings from test-evidence/.
    try:
        from ...tools.storage import StorageTool as _ST_p3  # type: ignore
    except ImportError:
        try:
            import sys as _sys_p3, pathlib as _pl_p3
            _root_p3 = str(_pl_p3.Path(__file__).resolve().parents[2])
            if _root_p3 not in _sys_p3.path:
                _sys_p3.path.insert(0, _root_p3)
            from tools.storage import StorageTool as _ST_p3  # type: ignore  # noqa: PLC0415
        except ImportError:
            _ST_p3 = None  # type: ignore

    if _ST_p3 is not None:
        _storage_p3 = _ST_p3()
        _project_dir_p3 = pathlib.Path(state.get("project_dir", "."))
        _project_slug_p3 = _project_dir_p3.name.replace(" ", "-").lower()
        _cloud_urls_p3: dict[str, str] = {}

        # Gather media artifacts from test-evidence/
        _te_dir = get_test_evidence_dir(_project_dir_p3, create=False)
        _media_candidates: list[pathlib.Path] = []
        if _te_dir.exists():
            for _ext in ("*.png", "*.jpg", "*.webm", "*.mp4"):
                _media_candidates.extend(sorted(_te_dir.glob(_ext)))

        # Also pick up any explicit paths from validation_results["chrome_mcp"]
        _chr = state.get("validation_results", {}).get("chrome_mcp", {})
        for _key in ("screenshot_path", "recording_path"):
            _candidate = _chr.get(_key)
            if _candidate:
                _p_cand = pathlib.Path(_candidate)
                if _p_cand.exists() and _p_cand not in _media_candidates:
                    _media_candidates.append(_p_cand)

        for _media_file in _media_candidates:
            _rkey = f"projects/{_project_slug_p3}/test-evidence/{_media_file.name}"
            try:
                _up = _storage_p3.upload(str(_media_file), remote_key=_rkey, public=True)
                if _up.get("success"):
                    _cloud_urls_p3[_media_file.name] = _up["url"]
                    sse({"type": "text_delta", "content": f"  \u2601\ufe0f  Uploaded {_media_file.name} \u2192 {_up['url']}\n"})
            except Exception as _up_err:
                sse({"type": "text_delta", "content": f"  \u26a0\ufe0f  Upload skipped for {_media_file.name}: {_up_err}\n"})

        if _cloud_urls_p3:
            state["cloud_artifact_urls"] = _cloud_urls_p3
            _p3_out = get_phase_dir(_project_dir_p3, 3)
            (_p3_out / "cloud-urls.json").write_text(json.dumps(_cloud_urls_p3, indent=2))

    sse({"type": "phase_complete", "phase": 3, "files": [str(f) for f in all_files]})
    log.log_end("SA5:UserFeedback", "Phase 3 complete")
    return state


# ------------------------------------------------------------------
# Graph assembly
# ------------------------------------------------------------------

def _auditor_router(state: Phase3State) -> str:
    """Conditional edge: after auditor runs, loop back to SA1 in YOLO mode if not done."""
    is_yolo: bool = state.get("is_yolo", False)
    pct: float = (state.get("auditor_result") or {}).get("completion_pct", 0)
    iteration: int = state.get("auditor_iteration", 0)
    max_iter: int = state.get("auditor_max_iterations", 10)

    if not is_yolo:
        return END  # HIL: auditor already handled loop internally
    if pct >= 100:
        return END
    if iteration >= max_iter:
        return END
    return "sa1_frontend_design"  # YOLO loop: re-run SA1–SA4–SA5–auditor


def _sa5_to_auditor_or_end(state: Phase3State) -> str:
    """After SA5, always run auditor in YOLO mode; in HIL mode go directly to END."""
    is_yolo: bool = state.get("is_yolo", False)
    return "run_auditor" if is_yolo else END


def build_phase3_graph() -> Any:
    if not LANGGRAPH_AVAILABLE:
        return None
    graph = StateGraph(Phase3State)
    for name, fn in [
        ("sa1_frontend_design", sa1_frontend_design),
        ("sa2_backend_frame", sa2_backend_frame),
        ("sa3_integration_wiring", sa3_integration_wiring),
        ("sa4_debugging_testing", sa4_debugging_testing),
        ("sa5_user_feedback", sa5_user_feedback),
        ("run_auditor", run_auditor_node),
    ]:
        graph.add_node(name, fn)
    graph.set_entry_point("sa1_frontend_design")
    graph.add_edge("sa1_frontend_design", "sa2_backend_frame")
    graph.add_edge("sa2_backend_frame", "sa3_integration_wiring")
    graph.add_edge("sa3_integration_wiring", "sa4_debugging_testing")
    graph.add_edge("sa4_debugging_testing", "sa5_user_feedback")
    # SA5 → auditor (YOLO) or END (HIL)
    graph.add_conditional_edges("sa5_user_feedback", _sa5_to_auditor_or_end, {"run_auditor": "run_auditor", END: END})
    # Auditor → SA1 loop (YOLO, not done) or END (done / HIL)
    graph.add_conditional_edges("run_auditor", _auditor_router, {"sa1_frontend_design": "sa1_frontend_design", END: END})
    return graph.compile()


async def run_phase3(
    project_dir: str,
    user_id: str = "anonymous",
    is_yolo: bool = False,
    send_sse: Any = None,
    input_queue: Any = None,
    retry_patch_plan: dict | None = None,  # T-CLI-23: targeted patch context from Phase 4
    context_budget: "dict | None" = None,  # T103: ContextBudget.get_all() dict
    wireframe_svg: str = "",  # T-P3-01: SVG from Phase 2 (passed from run_phase2 return)
    penpot_project_url: str | None = None,  # T-P3-02: Penpot browseable URL
) -> dict[str, Any]:
    _sse = send_sse or (lambda e: None)
    # T-CLI-26: Read Phase 1 Mem0 context for continuity
    try:
        from ..shared.mem0_context import retrieve_phase1_context  # noqa: PLC0415
        _mem0_ctx = retrieve_phase1_context(user_id, project_dir)
    except Exception:
        _mem0_ctx = ""
    log = ExecutionLog(project_dir=project_dir)
    p1 = _load_phase_summary(project_dir, 1)
    p2 = _load_phase_summary(project_dir, 2)

    # T-P3-01: Load wireframe SVG from disk if not provided by caller
    _wireframe_svg = wireframe_svg
    if not _wireframe_svg:
        try:
            from ..shared.paths import get_wireframes_dir  # noqa: PLC0415
            _wf_dir = get_wireframes_dir(project_dir, create=False)
            for _wf_name in ("Wireframe_generated.svg", "wireframe-final.svg", "wireframe.svg"):
                _wf_path = _wf_dir / _wf_name
                if _wf_path.exists():
                    _wireframe_svg = _wf_path.read_text()[:8000]
                    _sse({"type": "text_delta", "content": f"  📐 Loaded wireframe from disk: {_wf_name}\n"})
                    break
        except Exception:
            pass

    # T-P3-02: Load penpot_project_url from disk manifest if not provided by caller
    _penpot_url = penpot_project_url
    if not _penpot_url:
        try:
            import json as _json
            _manifest_path = pathlib.Path(project_dir) / ".pakalon-agents" / "ai-agents" / "phase-2" / "url-manifest.json"
            if _manifest_path.exists():
                _manifest = _json.loads(_manifest_path.read_text())
                _penpot_url = _manifest.get("penpot_project_url") or _manifest.get("penpot_file_url")
        except Exception:
            pass

    initial: Phase3State = {
        "project_dir": project_dir,
        "user_id": user_id,
        "is_yolo": is_yolo,
        "send_sse": _sse,
        "_input_queue": input_queue,
        "execution_log": log,
        "phase1_summary": p1,
        "context_budget": context_budget,
        "phase2_summary": p2,
        "retry_patch_plan": retry_patch_plan,
        "_mem0_context": _mem0_ctx,  # type: ignore
        "wireframe_svg": _wireframe_svg,  # T-P3-01
        "penpot_project_url": _penpot_url,  # T-P3-02
        # Auditor state
        "auditor_result": None,
        "auditor_iteration": 0,
        "auditor_max_iterations": 10 if is_yolo else 3,
    }
    # T103: Wire context budget into module-level cap for _llm helper
    global _phase_budget_cap
    if context_budget:
        # Use SA1 budget cap as the per-call ceiling for phase 3 (most LLM-heavy subagent)
        _phase_budget_cap = context_budget.get("phase3_sa1") or None
    graph = build_phase3_graph()
    if graph is None:
        state: Any = initial
        for fn in [sa1_frontend_design, sa2_backend_frame, sa3_integration_wiring, sa4_debugging_testing, sa5_user_feedback]:
            state = await fn(state)
        # Fallback: run auditor once in YOLO mode when LangGraph is unavailable
        if is_yolo:
            state = await run_auditor_node(state)
    else:
        state = await graph.ainvoke(initial)
    return {
        "status": "complete",
        "outputs_saved": state.get("outputs_saved", []),
        "validation": state.get("validation_results", {}),
        "skip_phase4": state.get("skip_phase4", False),
        "auditor_result": state.get("auditor_result"),
        "auditor_iteration": state.get("auditor_iteration", 0),
    }
