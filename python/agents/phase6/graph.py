"""
graph.py — Phase 6 LangGraph StateGraph: Documentation Agent.
T121: Read all phase outputs → generate DOC.md, API docs, README, CHANGELOG.
P4:   Enhanced with real source scanning, git log CHANGELOG, function-level docs.
Nodes: collect_all_phases → scan_source → generate_api_docs → generate_readme
       → generate_changelog → generate_function_docs → finalize_doc_md
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import subprocess
from typing import Any, TypedDict

try:
    from langgraph.graph import StateGraph, END  # type: ignore
    LANGGRAPH_AVAILABLE = True
except ImportError:
    LANGGRAPH_AVAILABLE = False

from ..shared.paths import get_phase_dir


class Phase6State(TypedDict, total=False):
    project_dir: str
    user_id: str
    is_yolo: bool
    send_sse: Any
    all_phases_context: dict
    source_scan: dict          # P4: scanned source info
    api_docs: str
    function_docs: str         # P4: function/class level docs
    readme_content: str
    changelog_content: str
    doc_md: str
    openapi_spec: dict          # T6-OAS: generated OpenAPI 3.0 spec dict
    openapi_html: str           # T6-OAS: self-contained Swagger UI HTML
    storybook_stories: dict     # T6-SB:  {component_path: story_content}
    github_pages_url: str       # T-P6-PAGES: URL of deployed GitHub Pages site
    outputs_saved: list[str]

    context_budget: dict | None  # T103: optional ContextBudget.get_all() dict for per-phase max_tokens caps

# ------------------------------------------------------------------
# LLM helper
# ------------------------------------------------------------------

# T103: Module-level budget cap — set by run_phase6() when context_budget is provided.
_phase_budget_cap: int | None = None

async def _llm(prompt: str, max_tokens: int = 4000, system: str | None = None, _budget_cap: int | None = None) -> str:
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    effective_cap = _budget_cap or _phase_budget_cap
    if not api_key:
        return f"<!-- No OPENROUTER_API_KEY — placeholder -->\n\n{prompt[:200]}"
    try:
        import httpx
        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": os.environ.get("PAKALON_MODEL", "anthropic/claude-3-5-haiku"),
                    "messages": [
                        {
                            "role": "system",
                            "content": system or "You are a senior technical writer. Generate clear, accurate, production-quality documentation in Markdown. Be comprehensive but concise.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": min(max_tokens, effective_cap) if effective_cap else max_tokens,
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f"<!-- LLM error: {e} -->"


def _load_all_phases(project_dir: str) -> dict[str, dict]:
    root = pathlib.Path(project_dir)
    context: dict = {}
    for phase_num in range(1, 6):
        phase_dir = get_phase_dir(root, phase_num, create=False)
        if phase_dir.exists():
            context[f"phase{phase_num}"] = {}
            for f in sorted(phase_dir.glob("*.md"))[:8]:
                context[f"phase{phase_num}"][f.name] = f.read_text()[:3000]
    return context


# ------------------------------------------------------------------
# P4: Source scanner — extract routes, functions, classes, exports
# ------------------------------------------------------------------

def _scan_source_files(project_dir: str) -> dict:
    """
    Scan project source files for:
    - API routes (FastAPI, Express, Next.js)
    - Function/class signatures with docstrings
    - TypeScript/Python exports
    - Package metadata (package.json, pyproject.toml)
    """
    root = pathlib.Path(project_dir)
    result: dict[str, Any] = {
        "routes": [],
        "functions": [],
        "classes": [],
        "exports": [],
        "packages": {},
        "file_summary": [],
    }

    # Read package.json if present
    pkg_json = root / "package.json"
    if pkg_json.exists():
        try:
            data = json.loads(pkg_json.read_text())
            result["packages"]["npm"] = {
                "name": data.get("name"),
                "version": data.get("version"),
                "description": data.get("description"),
                "dependencies": list(data.get("dependencies", {}).keys())[:20],
                "scripts": list(data.get("scripts", {}).keys()),
            }
        except Exception:
            pass

    # Read pyproject.toml if present
    pyproject = root / "pyproject.toml"
    if pyproject.exists():
        try:
            content = pyproject.read_text()[:2000]
            result["packages"]["python"] = {"raw": content}
        except Exception:
            pass

    # Scan Python files for routes and functions
    py_routes_re = re.compile(r'@(?:app|router)\.(get|post|put|delete|patch)\(["\']([^"\']+)["\']')
    py_fn_re = re.compile(r'^(?:async\s+)?def\s+(\w+)\(([^)]*)\)(?:\s*->\s*([^:]+))?:', re.MULTILINE)
    py_class_re = re.compile(r'^class\s+(\w+)(?:\(([^)]*)\))?:', re.MULTILINE)
    py_doc_re = re.compile(r'"""(.*?)"""', re.DOTALL)

    # Scan TypeScript/JavaScript files for routes and exports
    ts_route_re = re.compile(r'(?:router|app)\.(get|post|put|delete|patch)\(["\']([^"\']+)["\']')
    ts_fn_re = re.compile(r'(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?')
    ts_export_re = re.compile(r'export\s+(?:const|class|function|interface|type)\s+(\w+)')
    nextjs_route_re = re.compile(r'export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD)')

    # Scan source directories
    scan_dirs = ["src", "app", "api", "lib", "backend/app"]
    scan_extensions = {".py", ".ts", ".tsx", ".js", ".jsx"}

    scanned_count = 0
    for scan_dir in scan_dirs:
        src_path = root / scan_dir
        if not src_path.exists():
            continue
        for fpath in sorted(src_path.rglob("*"))[:200]:
            if fpath.suffix not in scan_extensions:
                continue
            if any(skip in str(fpath) for skip in ["node_modules", "__pycache__", ".git", "dist", ".next", "build"]):
                continue
            try:
                content = fpath.read_text(encoding="utf-8", errors="ignore")[:8000]
                rel = str(fpath.relative_to(root))
                scanned_count += 1

                if fpath.suffix == ".py":
                    for m in py_routes_re.finditer(content):
                        result["routes"].append({"method": m.group(1).upper(), "path": m.group(2), "file": rel})
                    for m in py_fn_re.finditer(content):
                        fname = m.group(1)
                        if not fname.startswith("_"):  # skip private
                            result["functions"].append({
                                "name": fname,
                                "params": m.group(2)[:80],
                                "returns": (m.group(3) or "").strip()[:40],
                                "file": rel,
                            })
                    for m in py_class_re.finditer(content):
                        result["classes"].append({"name": m.group(1), "base": m.group(2) or "", "file": rel})

                elif fpath.suffix in {".ts", ".tsx", ".js", ".jsx"}:
                    for m in ts_route_re.finditer(content):
                        result["routes"].append({"method": m.group(1).upper(), "path": m.group(2), "file": rel})
                    # Next.js App Router routes
                    for m in nextjs_route_re.finditer(content):
                        route_path = "/" + "/".join(
                            p for p in fpath.parts
                            if p not in {"app", "src", "api", "route.ts", "route.tsx", "route.js"}
                            and not p.endswith((".ts", ".tsx", ".js"))
                        )
                        result["routes"].append({"method": m.group(1), "path": route_path or "/", "file": rel})
                    for m in ts_fn_re.finditer(content):
                        result["functions"].append({
                            "name": m.group(1),
                            "params": m.group(2)[:80],
                            "returns": (m.group(3) or "").strip()[:40],
                            "file": rel,
                        })
                    for m in ts_export_re.finditer(content):
                        result["exports"].append({"name": m.group(1), "file": rel})

                if len(content) > 100:
                    result["file_summary"].append(f"{rel} ({fpath.suffix}, {len(content)} chars)")

            except Exception:
                pass

    # Deduplicate
    seen_routes: set = set()
    unique_routes = []
    for r in result["routes"]:
        key = f"{r['method']}:{r['path']}"
        if key not in seen_routes:
            seen_routes.add(key)
            unique_routes.append(r)
    result["routes"] = unique_routes[:50]
    result["functions"] = result["functions"][:80]
    result["classes"] = result["classes"][:40]
    result["file_summary"] = result["file_summary"][:30]
    result["scanned_files"] = scanned_count

    return result


def _get_git_log(project_dir: str, n: int = 50) -> str:
    """Get recent git commits for CHANGELOG generation."""
    try:
        result = subprocess.run(
            ["git", "log", f"-{n}", "--pretty=format:%H|%as|%s|%an", "--no-merges"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _get_git_tags(project_dir: str) -> list[str]:
    """Get git tags for version history."""
    try:
        result = subprocess.run(
            ["git", "tag", "--sort=-version:refname"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip().split("\n")[:10]
    except Exception:
        pass
    return []


# ------------------------------------------------------------------
# Nodes
# ------------------------------------------------------------------

async def collect_all_phases(state: Phase6State) -> Phase6State:
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📚 Phase 6: Collecting all phase outputs…\n"})
    state["all_phases_context"] = _load_all_phases(state.get("project_dir", "."))
    return state


async def scan_source(state: Phase6State) -> Phase6State:
    """P4: Scan actual source files for routes, functions, classes."""
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🔍 Scanning source files for API routes and functions…\n"})
    project_dir = state.get("project_dir", ".")
    state["source_scan"] = await asyncio.to_thread(_scan_source_files, project_dir)
    count = state["source_scan"].get("scanned_files", 0)
    routes = len(state["source_scan"].get("routes", []))
    fns = len(state["source_scan"].get("functions", []))
    sse({"type": "text_delta", "content": f"  → Scanned {count} files, found {routes} routes, {fns} functions\n"})
    return state


async def generate_api_docs(state: Phase6State) -> Phase6State:
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📡 Generating API documentation…\n"})

    scan = state.get("source_scan", {})
    phase_ctx = state.get("all_phases_context", {})
    tech_spec = phase_ctx.get("phase1", {}).get("technical-spec.md", "")

    routes = scan.get("routes", [])
    packages = scan.get("packages", {})

    # Format routes for the prompt
    routes_block = ""
    if routes:
        routes_block = "**Discovered API Routes:**\n" + "\n".join(
            f"- `{r['method']} {r['path']}` ({r['file']})"
            for r in routes[:30]
        )

    npm_info = ""
    if packages.get("npm"):
        pkg = packages["npm"]
        npm_info = f"Package: {pkg.get('name')} v{pkg.get('version')}\nDeps: {', '.join((pkg.get('dependencies') or [])[:10])}"

    prompt = f"""Generate comprehensive API documentation for this project.

{routes_block}

**Technical Spec:**
{tech_spec[:2000]}

**Package Info:**
{npm_info}

Generate a well-structured API.md with:
1. Overview section
2. Authentication (if applicable)
3. For each discovered route: method, path, description, request body schema, response schema, example, error codes
4. Data models/schemas section
5. Error handling guide
6. Rate limiting info (if mentioned in spec)

Use proper Markdown with code blocks for JSON examples. Be thorough and developer-friendly."""

    state["api_docs"] = await _llm(prompt, max_tokens=5000)
    return state


async def generate_function_docs(state: Phase6State) -> Phase6State:
    """P4: Generate function-level documentation from scanned source."""
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📦 Generating function and class documentation…\n"})

    scan = state.get("source_scan", {})
    functions = scan.get("functions", [])
    classes = scan.get("classes", [])
    exports = scan.get("exports", [])

    if not functions and not classes:
        state["function_docs"] = "# Module Reference\n\nNo public functions or classes detected.\n"
        return state

    # Group by file
    by_file: dict[str, list] = {}
    for fn in functions[:60]:
        by_file.setdefault(fn["file"], []).append(fn)
    for cls in classes[:30]:
        by_file.setdefault(cls["file"], []).append({**cls, "_type": "class"})

    fn_list = "\n".join(
        f"- `{fn['name']}({fn['params'][:50]})` → `{fn['returns']}` in {fn['file']}"
        for fn in functions[:50]
    )
    cls_list = "\n".join(
        f"- `class {cls['name']}({cls.get('base', '')})` in {cls['file']}"
        for cls in classes[:20]
    )

    prompt = f"""Generate a Module Reference documentation page for these functions and classes.

**Functions ({len(functions)} total):**
{fn_list}

**Classes ({len(classes)} total):**
{cls_list}

Create a Markdown document (MODULES.md) with:
1. Quick reference table of all public functions/classes
2. Grouped by source file
3. For each function: description, parameters, return type, usage example
4. For each class: description, constructor, key methods

Focus on usability. Infer purpose from names and file paths."""

    state["function_docs"] = await _llm(prompt, max_tokens=4000)
    return state



# ─────────────────────────────────────────────────────────────────────────────
# Stack detection + per-stack README templates
# ─────────────────────────────────────────────────────────────────────────────

def _detect_stack(project_dir: str) -> str:
    """
    Detect the primary technology stack of the project.
    Returns one of: "nextjs" | "react" | "fastapi" | "python" | "go" | "node" | "unknown"
    """
    root = pathlib.Path(project_dir)

    # Check package.json for JS/TS frameworks
    pkg_json = root / "package.json"
    if pkg_json.exists():
        try:
            pkg = json.loads(pkg_json.read_text())
            deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
            if "next" in deps:
                return "nextjs"
            if "react" in deps or "react-dom" in deps:
                return "react"
        except Exception:
            pass

    # Python
    if (root / "pyproject.toml").exists() or (root / "requirements.txt").exists():
        # Distinguish FastAPI from generic Python
        for src_file in list(root.rglob("*.py"))[:30]:
            try:
                content = src_file.read_text(errors="replace")
                if "from fastapi" in content or "import fastapi" in content:
                    return "fastapi"
            except OSError:
                pass
        return "python"

    if (root / "go.mod").exists():
        return "go"

    if (root / "package.json").exists():
        return "node"

    return "unknown"


_STACK_README_SECTIONS: dict[str, dict[str, str]] = {
    "nextjs": {
        "prerequisites": "- **Node.js** ≥ 18\n- **pnpm** / npm / yarn\n- A `.env.local` file (see Configuration)",
        "install": "```bash\npnpm install\n```",
        "dev": "```bash\npnpm dev       # http://localhost:3000\n```",
        "build": "```bash\npnpm build\npnpm start\n```",
        "test": "```bash\npnpm test\n```",
        "stack_note": "Built with **Next.js** (App Router), **TypeScript**, and **Tailwind CSS**.",
    },
    "react": {
        "prerequisites": "- **Node.js** ≥ 18\n- **npm** / yarn",
        "install": "```bash\nnpm install\n```",
        "dev": "```bash\nnpm start      # http://localhost:3000\n```",
        "build": "```bash\nnpm run build\n```",
        "test": "```bash\nnpm test\n```",
        "stack_note": "Built with **React** and **TypeScript**.",
    },
    "fastapi": {
        "prerequisites": "- **Python** ≥ 3.11\n- **pip** / uv / poetry\n- **PostgreSQL** (see docker-compose.yml)",
        "install": "```bash\npip install -e .\n# or\nuv pip install -e .\n```",
        "dev": "```bash\nuvicorn app.main:create_app --factory --reload\n# http://localhost:8000\n```",
        "build": "```bash\ndocker compose up --build\n```",
        "test": "```bash\npytest\n```",
        "stack_note": "Built with **FastAPI**, **SQLAlchemy** (async), and **Alembic** migrations.",
    },
    "python": {
        "prerequisites": "- **Python** ≥ 3.11\n- **pip** / uv",
        "install": "```bash\npip install -e .\n```",
        "dev": "```bash\npython -m <module>\n```",
        "build": "```bash\npython -m build\n```",
        "test": "```bash\npytest\n```",
        "stack_note": "Pure Python project.",
    },
    "go": {
        "prerequisites": "- **Go** ≥ 1.22",
        "install": "```bash\ngo mod download\n```",
        "dev": "```bash\ngo run .\n```",
        "build": "```bash\ngo build -o bin/app .\n```",
        "test": "```bash\ngo test ./...\n```",
        "stack_note": "Written in **Go**.",
    },
    "node": {
        "prerequisites": "- **Node.js** ≥ 18",
        "install": "```bash\nnpm install\n```",
        "dev": "```bash\nnpm start\n```",
        "build": "```bash\nnpm run build\n```",
        "test": "```bash\nnpm test\n```",
        "stack_note": "Node.js application.",
    },
    "unknown": {
        "prerequisites": "See project documentation.",
        "install": "Follow the project setup guide.",
        "dev": "See development instructions.",
        "build": "See build instructions.",
        "test": "See test instructions.",
        "stack_note": "",
    },
}


async def generate_readme(state: Phase6State) -> Phase6State:
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📝 Generating README…\n"})

    project_dir = state.get("project_dir", ".")
    stack = _detect_stack(project_dir)
    tpl = _STACK_README_SECTIONS.get(stack, _STACK_README_SECTIONS["unknown"])

    sse({"type": "text_delta", "content": f"   Detected stack: {stack}\n"})

    scan = state.get("source_scan", {})
    phase_ctx = state.get("all_phases_context", {})
    plan = phase_ctx.get("phase1", {}).get("plan.md", "")
    tech_spec = phase_ctx.get("phase1", {}).get("technical-spec.md", "")

    packages = scan.get("packages", {})
    npm = packages.get("npm", {})
    project_name = npm.get("name", pathlib.Path(project_dir).name)
    description = npm.get("description") or ""
    scripts = npm.get("scripts", [])
    file_summary = scan.get("file_summary", [])[:10]

    # Check if we should update or create fresh
    output_path = pathlib.Path(project_dir) / "README.md"
    is_update = output_path.exists() and len(output_path.read_text().strip()) > 200

    prompt = f"""Generate a comprehensive, production-quality README.md for this project.

**Project Name:** {project_name}
**Stack:** {stack} — {tpl.get('stack_note', '')}
**Description:** {description}
**Mode:** {"UPDATE existing README (preserve existing sections, enhance with new info)" if is_update else "CREATE fresh README"}

**Project Plan:**
{plan[:2000]}

**Technical Spec (excerpt):**
{tech_spec[:1500]}

**Available npm scripts:** {', '.join(scripts)}

**Key source files:**
{chr(10).join(file_summary)}

Use this stack-specific boilerplate for code sections:

### Prerequisites
{tpl['prerequisites']}

### Installation
{tpl['install']}

### Development
{tpl['dev']}

### Build
{tpl['build']}

### Testing
{tpl['test']}

Create a README.md with these sections:
## Overview
A clear 2-3 sentence description of what this project does and why.

## Features
Bullet list of key features (infer from plan and source structure).

## Prerequisites
{tpl['prerequisites']}

## Installation
{tpl['install']}

## Usage
Common usage examples with code blocks.

## Configuration
Environment variables and config options table.

## Development
{tpl['dev']}

## API Reference
Brief overview and link to API.md.

## Contributing
Contribution guidelines.

## License
MIT or inferred from project.

Make it friendly, well-formatted. Use the exact code blocks from the stack template above."""

    state["readme_content"] = await _llm(prompt, max_tokens=5000)
    return state


async def generate_changelog(state: Phase6State) -> Phase6State:
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📋 Generating CHANGELOG from git history…\n"})

    project_dir = state.get("project_dir", ".")
    git_log = await asyncio.to_thread(_get_git_log, project_dir, 60)
    git_tags = await asyncio.to_thread(_get_git_tags, project_dir)
    tasks = state.get("all_phases_context", {}).get("phase1", {}).get("tasks.md", "")

    if git_log:
        # Parse commits into structured format
        commits = []
        for line in git_log.split("\n"):
            parts = line.split("|", 3)
            if len(parts) == 4:
                commits.append({"sha": parts[0][:8], "date": parts[1], "subject": parts[2], "author": parts[3]})

        commits_text = "\n".join(
            f"- {c['date']} | {c['subject']} ({c['author']})"
            for c in commits[:40]
        )
        tags_text = f"Version tags: {', '.join(git_tags)}" if git_tags else "No version tags found."

        prompt = f"""Generate a CHANGELOG.md in Keep a Changelog format (https://keepachangelog.com).

**Git commits:**
{commits_text}

**{tags_text}**

**Project tasks:**
{tasks[:1000]}

Create CHANGELOG.md with:
- Group commits by version (use tags if present, otherwise create v1.0.0)
- Sections: Added, Changed, Fixed, Deprecated, Removed, Security
- Each section lists relevant commits in plain English
- Most recent version first
- Include dates
- Brief Unreleased section at top for any very recent commits

Keep it concise but complete."""
    else:
        # No git history — generate from tasks
        prompt = f"""Generate a CHANGELOG.md in Keep a Changelog format based on project tasks.

**Project tasks:**
{tasks[:2000]}

Create an initial CHANGELOG.md for v1.0.0 with Added/Changed/Fixed sections.
List features as Added items. Make it look professional."""

    state["changelog_content"] = await _llm(prompt, max_tokens=3000)
    return state


# ------------------------------------------------------------------
# T6-OAS: OpenAPI 3.0 spec + Swagger HTML generation
# ------------------------------------------------------------------

def _build_openapi_skeleton(project_dir: str, source_scan: dict) -> dict:
    """
    Build a baseline OpenAPI 3.0 spec from the routes discovered by _scan_source_files.
    Returns a dict ready to be serialised as openapi.json.
    """
    root = pathlib.Path(project_dir)
    npm = source_scan.get("packages", {}).get("npm", {})
    python_meta = source_scan.get("packages", {}).get("python", {}).get("raw", "")

    # Infer title/version
    title = npm.get("name") or root.name
    version = npm.get("version") or "0.1.0"
    description = npm.get("description") or ""

    # Parse title/version from pyproject.toml if present
    if not version or version == "0.1.0":
        for line in python_meta.splitlines():
            if line.startswith("version"):
                try:
                    version = line.split("=")[-1].strip().strip('"')
                except Exception:
                    pass
            if line.startswith("name"):
                try:
                    candidate = line.split("=")[-1].strip().strip('"')
                    if candidate:
                        title = candidate
                except Exception:
                    pass

    # Build paths from discovered routes
    paths: dict = {}
    for route in source_scan.get("routes", []):
        method = route.get("method", "GET").lower()
        path = route.get("path", "/")
        # Normalise FastAPI path → OpenAPI path (same format)
        if path not in paths:
            paths[path] = {}
        paths[path][method] = {
            "summary": f"{route.get('method', 'GET')} {path}",
            "description": f"Endpoint in `{route.get('file', '')}`.",
            "operationId": f"{method}_{path.replace('/', '_').strip('_') or 'root'}",
            "responses": {
                "200": {"description": "Successful response"},
                "400": {"description": "Bad request"},
                "401": {"description": "Unauthorized"},
                "500": {"description": "Internal server error"},
            },
        }

    spec: dict = {
        "openapi": "3.0.3",
        "info": {
            "title": title,
            "version": version,
            "description": description,
        },
        "paths": paths,
        "components": {
            "securitySchemes": {
                "BearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "bearerFormat": "JWT",
                }
            }
        },
        "security": [{"BearerAuth": []}],
    }
    return spec


def _build_swagger_html(spec_content: str, title: str = "API Documentation") -> str:
    """
    Generate a self-contained Swagger UI HTML page that embeds the spec inline.
    No external server required — the JSON is embedded as a JS variable.
    """
    # Escape backticks inside spec_content so it can be embedded in a JS template literal
    escaped = spec_content.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title} — API Reference</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body {{ margin: 0; background: #fafafa; }}
    .swagger-ui .topbar {{ background-color: #1a1a2e; }}
    .swagger-ui .topbar a {{ color: #ffffff; }}
    #banner {{ background: #1a1a2e; color: #fff; padding: 12px 24px; font-family: sans-serif; font-size: 14px; }}
  </style>
</head>
<body>
  <div id="banner">
    <strong>{title}</strong> &nbsp;·&nbsp; Auto-generated by <strong>Pakalon AI Phase 6</strong>
  </div>
  <div id="swagger-ui"></div>
  <script>
    const specJson = `{escaped}`;
    const spec = JSON.parse(specJson);
  </script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = () => {{
      SwaggerUIBundle({{
        spec,
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
        deepLinking: true,
        showExtensions: true,
        showCommonExtensions: true,
      }});
    }};
  </script>
</body>
</html>"""


async def generate_openapi_spec(state: Phase6State) -> Phase6State:
    """
    T6-OAS: Build an OpenAPI 3.0 JSON spec from scanned routes, then enhance each
    path entry with LLM-generated descriptions, request/response schemas, and
    parameter documentation. Also generates a self-contained Swagger UI HTML file.
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📐 Generating OpenAPI 3.0 spec + Swagger HTML…\n"})

    project_dir = state.get("project_dir", ".")
    source_scan = state.get("source_scan", {})
    phase_ctx = state.get("all_phases_context", {})
    tech_spec = phase_ctx.get("phase1", {}).get("technical-spec.md", "")

    routes = source_scan.get("routes", [])
    if not routes:
        # No routes found — generate a minimal placeholder spec
        spec: dict = {
            "openapi": "3.0.3",
            "info": {"title": pathlib.Path(project_dir).name, "version": "0.1.0", "description": ""},
            "paths": {},
        }
        state["openapi_spec"] = spec
        state["openapi_html"] = _build_swagger_html(
            json.dumps(spec, indent=2), title=spec["info"]["title"]
        )
        sse({"type": "text_delta", "content": "  → No API routes found; placeholder spec generated\n"})
        return state

    # Build skeleton spec
    spec = _build_openapi_skeleton(project_dir, source_scan)

    # Ask the LLM to enhance the spec with proper descriptions and schemas
    routes_summary = "\n".join(
        f"- {r['method']} {r['path']}  ({r['file']})"
        for r in routes[:30]
    )
    existing_spec_json = json.dumps(spec, indent=2)

    prompt = f"""You are generating an OpenAPI 3.0.3 specification for a production API.

**Discovered routes:**
{routes_summary}

**Technical spec (excerpt):**
{tech_spec[:1500]}

**Current skeleton spec (JSON):**
{existing_spec_json[:3000]}

Enhance this spec by:
1. Adding a clear `description` to the info section
2. For each path operation: realistic `summary`, `description`, `tags`, and `parameters` (path/query)
3. For POST/PUT operations: add a `requestBody` with `application/json` content and an example schema
4. For all operations: expand the `200` response with a real `schema` (using `$ref` or inline)
5. Add 2-4 reusable component schemas under `components.schemas` reflecting the data models
6. Keep the JSON valid and complete

Return ONLY the complete enhanced JSON (no markdown fences, no explanation).

IMPORTANT: Return valid JSON only. Start with {{ and end with }}"""

    llm_result = await _llm(prompt, max_tokens=6000)

    # Try to parse the LLM-enhanced spec; fall back to the skeleton if it's not valid JSON
    try:
        # Strip possible markdown code fences
        cleaned = llm_result.strip()
        if cleaned.startswith("```"):
            cleaned = "\n".join(cleaned.split("\n")[1:])
        if cleaned.endswith("```"):
            cleaned = "\n".join(cleaned.split("\n")[:-1])
        enhanced_spec = json.loads(cleaned)
        # Basic sanity check
        if not isinstance(enhanced_spec.get("paths"), dict):
            enhanced_spec = spec
    except Exception:
        enhanced_spec = spec

    state["openapi_spec"] = enhanced_spec
    title = enhanced_spec.get("info", {}).get("title", "API Reference")
    state["openapi_html"] = _build_swagger_html(json.dumps(enhanced_spec, indent=2), title=title)
    sse({"type": "text_delta", "content": f"  → OpenAPI spec with {len(enhanced_spec.get('paths', {}))} paths generated\n"})
    return state


# ------------------------------------------------------------------
# T6-SB: Storybook story generation for React/TypeScript components
# ------------------------------------------------------------------

def _find_react_components(project_dir: str) -> list[dict]:
    """
    Scan the project for React component files (.tsx) that have a component export.
    Returns up to 15 candidate components with their source content.
    """
    root = pathlib.Path(project_dir)
    components: list[dict] = []

    # Patterns that indicate a React component
    component_re = re.compile(
        r'(?:export\s+(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9]+)|'
        r'const\s+([A-Z][A-Za-z0-9]+)\s*(?::\s*React\.FC[^=]*)?=\s*\(?)',
    )

    candidate_dirs = ["components", "src/components", "app/components", "frontend/components",
                      "src/app", "src/ui", "src/views"]

    seen: set = set()
    for cdir in candidate_dirs:
        cpath = root / cdir
        if not cpath.exists():
            continue
        for fpath in sorted(cpath.rglob("*.tsx"))[:40]:
            if any(skip in str(fpath) for skip in ["node_modules", "__tests__", ".stories.", "test.", "spec."]):
                continue
            rel = str(fpath.relative_to(root))
            if rel in seen:
                continue
            try:
                content = fpath.read_text(encoding="utf-8", errors="ignore")[:4000]
                if not component_re.search(content):
                    continue
                seen.add(rel)
                # Extract component name
                m = component_re.search(content)
                name = (m.group(1) or m.group(2) or fpath.stem) if m else fpath.stem
                components.append({"file": rel, "name": name, "content": content})
                if len(components) >= 15:
                    return components
            except Exception:
                pass

    return components


async def generate_storybook_stories(state: Phase6State) -> Phase6State:
    """
    T6-SB: Generate Storybook CSF3 story files for discovered React components.
    One story file per component, saved in <doc_dir>/stories/ for reference.
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📖 Generating Storybook stories for React components…\n"})

    project_dir = state.get("project_dir", ".")
    components = await asyncio.to_thread(_find_react_components, project_dir)

    if not components:
        sse({"type": "text_delta", "content": "  → No React components found; skipping Storybook generation\n"})
        state["storybook_stories"] = {}
        return state

    stories: dict[str, str] = {}

    # Generate stories concurrently (max 5 at a time to avoid rate-limiting)
    async def _gen_one(comp: dict) -> tuple[str, str]:
        prompt = f"""Generate a complete Storybook CSF3 story file for this React component.

**Component name:** {comp['name']}
**File path:** {comp['file']}

**Component source:**
```tsx
{comp['content'][:2500]}
```

Create a `.stories.tsx` file that:
1. Has a proper `Meta` default export with `title` and `component`
2. Uses `StoryObj<typeof {comp['name']}>` type
3. Includes at minimum: `Default`, `WithProps` stories
4. Adds 2-3 realistic variant stories based on the component's props
5. Includes `args` with realistic prop values
6. Adds `argTypes` for important props with descriptions
7. Uses Storybook decorators if the component needs context (Router, Theme, etc.)

Use modern CSF3 format. Return ONLY the TypeScript code (no markdown fences)."""

        story_content = await _llm(prompt, max_tokens=2000)
        # Strip any markdown fences the LLM may have added
        story_content = story_content.strip()
        if story_content.startswith("```"):
            lines = story_content.split("\n")
            story_content = "\n".join(lines[1:])
        if story_content.endswith("```"):
            story_content = "\n".join(story_content.split("\n")[:-1])
        return comp["name"], story_content

    # Process in batches of 5 to avoid rate-limiting
    for i in range(0, len(components), 5):
        batch = components[i:i + 5]
        results = await asyncio.gather(*[_gen_one(c) for c in batch])
        for name, story in results:
            stories[name] = story

    sse({"type": "text_delta", "content": f"  → Generated stories for {len(stories)} component(s)\n"})
    state["storybook_stories"] = stories
    return state


async def finalize_doc_md(state: Phase6State) -> Phase6State:
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "📄 Writing final documentation files…\n"})
    project_dir = pathlib.Path(state.get("project_dir", "."))
    doc_dir = get_phase_dir(project_dir, 6)
    doc_dir.mkdir(parents=True, exist_ok=True)

    saved: list[str] = []

    # Write API.md
    api_path = doc_dir / "API.md"
    api_content = state.get("api_docs") or "# API Documentation\n\nNo API routes discovered.\n"
    api_path.write_text(api_content)
    saved.append(str(api_path))

    # Write MODULES.md (function-level docs)
    modules_path = doc_dir / "MODULES.md"
    modules_content = state.get("function_docs") or "# Module Reference\n\nNo modules documented.\n"
    modules_path.write_text(modules_content)
    saved.append(str(modules_path))

    # Write README.md (update, don't blindly overwrite)
    readme_path = project_dir / "README.md"
    ai_readme = state.get("readme_content") or ""
    if ai_readme:
        if readme_path.exists():
            existing = readme_path.read_text()
            marker = "<!-- pakalon-generated-readme -->"
            if marker not in existing:
                # Replace completely if it's a stub, else append
                if len(existing.strip()) < 200:
                    readme_path.write_text(ai_readme)
                else:
                    readme_path.write_text(f"<!-- Last generated by Pakalon -->\n{ai_readme}")
            else:
                # Already has generated content — replace the section
                readme_path.write_text(f"{marker}\n{ai_readme}")
        else:
            readme_path.write_text(ai_readme)
        saved.append(str(readme_path))
    elif not readme_path.exists():
        readme_path.write_text(f"# {project_dir.name}\n\nGenerated by Pakalon.\n")
        saved.append(str(readme_path))

    # Write CHANGELOG.md
    changelog_path = project_dir / "CHANGELOG.md"
    changelog_content = state.get("changelog_content") or "# CHANGELOG\n\n## [1.0.0]\n\n### Added\n- Initial release\n"
    if changelog_path.exists():
        existing = changelog_path.read_text()
        # Prepend the new Unreleased section without losing old history
        if "## [Unreleased]" in changelog_content and "## [Unreleased]" not in existing:
            unreleased_end = changelog_content.find("\n## [", changelog_content.find("## [Unreleased]") + 1)
            unreleased_section = changelog_content[:unreleased_end] if unreleased_end > 0 else changelog_content[:500]
            changelog_path.write_text(unreleased_section + "\n\n" + existing)
        # else: don't overwrite — user may have custom entries
    else:
        changelog_path.write_text(changelog_content)
    saved.append(str(changelog_path))

    # Build cross-linked master DOC.md
    phases = state.get("all_phases_context", {})
    source_scan = state.get("source_scan", {})
    routes = source_scan.get("routes", [])
    npm = source_scan.get("packages", {}).get("npm", {})
    project_name = npm.get("name") or project_dir.name

    routes_table = ""
    if routes:
        routes_table = "| Method | Path | File |\n|---|---|---|\n"
        routes_table += "\n".join(
            f"| `{r['method']}` | `{r['path']}` | {r['file']} |"
            for r in routes[:20]
        )

    doc_content = f"""# {project_name} — Project Documentation

> Auto-generated by **Pakalon AI** | [API Reference](./API.md) | [Module Docs](./MODULES.md) | [README](../README.md) | [CHANGELOG](../CHANGELOG.md)

---

## Table of Contents

1. [Phase 1: Planning & Architecture](#phase-1-planning--architecture)
2. [Phase 2: UI/UX Design](#phase-2-uiux-design)
3. [Phase 3: Implementation](#phase-3-implementation)
4. [Phase 4: Security & QA](#phase-4-security--qa)
5. [Phase 5: CI/CD & Deployment](#phase-5-cicd--deployment)
6. [API Reference](./API.md)
7. [Module Reference](./MODULES.md)
8. [OpenAPI Spec](./openapi.json) | [Swagger UI](./swagger.html)
9. [Component Stories](./stories/)
10. [Discovered Routes](#discovered-api-routes)

---

## Phase 1: Planning & Architecture

{phases.get('phase1', {}).get('phase-1.md', '_No phase 1 output found_')}

---

## Phase 2: UI/UX Design

{phases.get('phase2', {}).get('phase-2.md', '_No phase 2 output found_')}

---

## Phase 3: Implementation

{phases.get('phase3', {}).get('phase-3.md', '_No phase 3 output found_')}

---

## Phase 4: Security & QA

{phases.get('phase4', {}).get('phase-4.md', '_No phase 4 output found_')}

---

## Phase 5: CI/CD & Deployment

{phases.get('phase5', {}).get('phase-5.md', '_No phase 5 output found_')}

---

## Discovered API Routes

{routes_table or '_No API routes discovered in source scan._'}

---

_Generated by Pakalon Phase 6 Documentation Agent_
"""
    doc_path = doc_dir / "DOC.md"
    doc_path.write_text(doc_content)
    saved.append(str(doc_path))

    # ── T6-OAS: Save openapi.json + swagger.html ──────────────────────────────
    openapi_spec = state.get("openapi_spec")
    openapi_html = state.get("openapi_html")
    if openapi_spec:
        oas_path = doc_dir / "openapi.json"
        oas_path.write_text(json.dumps(openapi_spec, indent=2))
        saved.append(str(oas_path))
    if openapi_html:
        swagger_path = doc_dir / "swagger.html"
        swagger_path.write_text(openapi_html)
        saved.append(str(swagger_path))

    # ── T6-SB: Save Storybook story files into doc_dir/stories/ ──────────────
    storybook_stories: dict = state.get("storybook_stories") or {}
    if storybook_stories:
        stories_dir = doc_dir / "stories"
        stories_dir.mkdir(parents=True, exist_ok=True)
        for component_name, story_content in storybook_stories.items():
            # Sanitise component name to a valid file stem
            safe_name = re.sub(r'[^\w]', '', component_name)
            story_path = stories_dir / f"{safe_name}.stories.tsx"
            story_path.write_text(story_content)
            saved.append(str(story_path))

    phase6_summary = f"""# Phase 6: Documentation

## Status: Complete ✅

## Generated Files

{chr(10).join('- [`' + pathlib.Path(p).name + '`](./' + pathlib.Path(p).name + ')' for p in saved)}

## Source Scan Summary

- Files scanned: {source_scan.get('scanned_files', 0)}
- API routes found: {len(routes)}
- Functions documented: {len(source_scan.get('functions', []))}
- Classes documented: {len(source_scan.get('classes', []))}
- OpenAPI spec: {'Generated (openapi.json + swagger.html)' if openapi_spec else 'Skipped (no routes)'}
- Storybook stories: {len(storybook_stories)} component(s)
"""
    (doc_dir / "phase-6.md").write_text(phase6_summary)
    saved.append(str(doc_dir / "phase-6.md"))

    state["doc_md"] = doc_content
    state["outputs_saved"] = saved
    sse({"type": "phase_complete", "phase": 6, "files": saved})
    return state


async def deploy_github_pages(state: Phase6State) -> Phase6State:
    """
    T-P6-PAGES: Deploy documentation to GitHub Pages.

    Generates a GitHub Actions workflow at .github/workflows/docs.yml that:
      - builds the documentation on push to main/master
      - deploys the docs/ folder to the gh-pages branch

    Also calls the GitHub REST API to enable Pages on the repository if gh CLI
    is available (requires GITHUB_TOKEN with repo permissions).
    """
    sse = state.get("send_sse") or (lambda e: None)
    sse({"type": "text_delta", "content": "🚀 Phase 6: Deploying docs to GitHub Pages...\n"})

    project_dir = pathlib.Path(state.get("project_dir", "."))
    workflows_dir = project_dir / ".github" / "workflows"
    workflows_dir.mkdir(parents=True, exist_ok=True)

    docs_workflow = """\
name: Deploy Documentation to GitHub Pages

on:
  push:
    branches: [main, master]
    paths:
      - 'docs/**'
      - 'README.md'
      - 'CHANGELOG.md'
  workflow_dispatch:

permissions:
  contents: write
  pages: write
  id-token: write

jobs:
  deploy-docs:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: './docs'

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
"""

    workflow_path = workflows_dir / "docs.yml"
    if not workflow_path.exists():
        workflow_path.write_text(docs_workflow)
        sse({"type": "text_delta", "content": f"  Created {workflow_path}\n"})
        saved = list(state.get("outputs_saved") or [])
        saved.append(str(workflow_path))
        state["outputs_saved"] = saved
    else:
        sse({"type": "text_delta", "content": f"  {workflow_path} already exists — skipping\n"})

    # Try to enable GitHub Pages via gh CLI
    pages_url = ""
    try:
        repo_result = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
            capture_output=True, text=True, cwd=str(project_dir), timeout=10,
        )
        repo_name = repo_result.stdout.strip() if repo_result.returncode == 0 else ""

        if repo_name:
            # Enable Pages via REST API
            github_token = os.environ.get("GITHUB_TOKEN", "")
            if github_token:
                try:
                    import httpx
                    async with httpx.AsyncClient(timeout=20) as client:
                        resp = await client.post(
                            f"https://api.github.com/repos/{repo_name}/pages",
                            headers={
                                "Authorization": f"Bearer {github_token}",
                                "Accept": "application/vnd.github+json",
                                "X-GitHub-Api-Version": "2022-11-28",
                            },
                            json={"source": {"branch": "gh-pages", "path": "/"}},
                        )
                        if resp.status_code in (201, 409):  # 409 = already enabled
                            owner, _, repo = repo_name.partition("/")
                            pages_url = f"https://{owner}.github.io/{repo}/"
                            sse({"type": "text_delta", "content": f"  GitHub Pages enabled: {pages_url}\n"})
                        else:
                            sse({"type": "text_delta", "content": f"  GitHub Pages API: {resp.status_code} (may need manual setup)\n"})
                except Exception as api_exc:
                    sse({"type": "text_delta", "content": f"  GitHub Pages API error: {api_exc}\n"})
            else:
                sse({"type": "text_delta", "content": f"  Set GITHUB_TOKEN to auto-enable Pages for {repo_name}\n"})
    except Exception:
        pass

    if pages_url:
        state["github_pages_url"] = pages_url  # type: ignore[typeddict-unknown-key]
    sse({"type": "text_delta", "content": "  ✔ docs.yml workflow created — push to main to trigger Pages deployment\n"})
    return state


# ------------------------------------------------------------------
# Graph
# ------------------------------------------------------------------

def build_phase6_graph() -> Any:
    if not LANGGRAPH_AVAILABLE:
        return None
    graph = StateGraph(Phase6State)
    nodes = [
        ("collect_all_phases", collect_all_phases),
        ("scan_source", scan_source),
        ("generate_api_docs", generate_api_docs),
        ("generate_readme", generate_readme),
        ("generate_changelog", generate_changelog),
        ("generate_function_docs", generate_function_docs),
        ("generate_openapi_spec", generate_openapi_spec),       # T6-OAS
        ("generate_storybook_stories", generate_storybook_stories),  # T6-SB
        ("finalize_doc_md", finalize_doc_md),
        ("deploy_github_pages", deploy_github_pages),
    ]
    for name, fn in nodes:
        graph.add_node(name, fn)
    graph.set_entry_point("collect_all_phases")
    graph.add_edge("collect_all_phases", "scan_source")
    graph.add_edge("scan_source", "generate_api_docs")
    graph.add_edge("generate_api_docs", "generate_readme")
    graph.add_edge("generate_readme", "generate_changelog")
    graph.add_edge("generate_changelog", "generate_function_docs")
    graph.add_edge("generate_function_docs", "generate_openapi_spec")
    graph.add_edge("generate_openapi_spec", "generate_storybook_stories")
    graph.add_edge("generate_storybook_stories", "finalize_doc_md")
    graph.add_edge("finalize_doc_md", "deploy_github_pages")
    graph.add_edge("deploy_github_pages", END)
    return graph.compile()


async def run_phase6(
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

    # HIL: confirm or skip Phase 6 before starting docs generation
    if not is_yolo and input_queue is not None:
        _sse({
            "type": "choice_request",
            "question": "Phase 5 (CI/CD) complete. Would you like to generate full documentation now?",
            "choices": [
                {"id": "go", "label": "📚 Generate documentation (DOC.md, README, API docs, CHANGELOG, module reference)"},
                {"id": "skip", "label": "⏭  Skip Phase 6 (documentation can be generated later)"},
            ],
        })
        try:
            answer = str(await asyncio.wait_for(input_queue.get(), timeout=120.0))
        except asyncio.TimeoutError:
            answer = "go"

        if answer.strip().lower() == "skip":
            _sse({"type": "text_delta", "content": "⏭ Phase 6 skipped by user.\n"})
            return {"status": "skipped", "outputs_saved": []}

    # T103: Wire context budget into module-level cap for _llm helper
    global _phase_budget_cap
    if context_budget:
        _phase_budget_cap = context_budget.get("phase6") or None

    initial: Phase6State = {"project_dir": project_dir, "user_id": user_id, "is_yolo": is_yolo, "send_sse": _sse, "context_budget": context_budget}
    graph = build_phase6_graph()
    if graph is None:
        state: Any = initial
        for fn in [collect_all_phases, scan_source, generate_api_docs, generate_readme, generate_changelog, generate_function_docs, generate_openapi_spec, generate_storybook_stories, finalize_doc_md, deploy_github_pages]:
            state = await fn(state)
    else:
        state = await graph.ainvoke(initial)
    return {"status": "complete", "outputs_saved": state.get("outputs_saved", [])}
