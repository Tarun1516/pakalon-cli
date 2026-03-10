"""
Skills Index - Central registry of all agent skills.

T-RAG-06: Dynamic GitHub fetch — fetches remote skill files from configured GitHub repos,
caches them locally for 24 hours, then falls back to bundled static files when offline.
"""
from __future__ import annotations

import json
import pathlib
import time
from typing import Any

# Path to skills directory
SKILLS_DIR = pathlib.Path(__file__).parent

# T-RAG-06: Remote skill sources — raw GitHub URLs fetched at runtime
_REMOTE_SKILL_SOURCES: list[dict[str, str]] = [
    {
        "name": "ui-ux-pro-max",
        "url": "https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/SKILL.md",
        "category": "frontend",
        "description": "Professional UI/UX design skill from nextlevelbuilder",
    },
    {
        "name": "vercel-agent-skills",
        "url": "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/README.md",
        "category": "frontend",
        "description": "Vercel Labs official agent skills",
    },
    {
        "name": "shadcn-components",
        "url": "https://raw.githubusercontent.com/shadcn-ui/ui/main/README.md",
        "category": "frontend",
        "description": "Shadcn UI component library guidance",
    },
]

_REMOTE_CACHE_TTL = 86_400  # 24 hours
_REMOTE_CACHE_DIR = pathlib.Path.home() / ".config" / "pakalon" / "skills_cache"


def _cache_path_for(name: str) -> pathlib.Path:
    _REMOTE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _REMOTE_CACHE_DIR / f"{name}.md"


def _meta_path() -> pathlib.Path:
    _REMOTE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _REMOTE_CACHE_DIR / "_meta.json"


def _fetch_remote_skill(source: dict[str, str]) -> str | None:
    """Fetch a single remote skill file via HTTP. Returns content or None on failure."""
    try:
        import httpx  # noqa: PLC0415
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(source["url"], headers={"User-Agent": "pakalon/1.0"})
            if resp.status_code == 200:
                return resp.text
    except Exception:
        pass
    return None


def _load_meta() -> dict[str, float]:
    try:
        return json.loads(_meta_path().read_text())
    except Exception:
        return {}


def _save_meta(meta: dict[str, float]) -> None:
    try:
        _meta_path().write_text(json.dumps(meta))
    except Exception:
        pass


def refresh_remote_skills(force: bool = False) -> None:
    """
    T-RAG-06: Fetch all remote skill sources and write to local cache.
    Only re-fetches when older than TTL unless force=True.
    """
    meta = _load_meta()
    now = time.time()
    updated = False
    for source in _REMOTE_SKILL_SOURCES:
        cached_at = meta.get(source["name"], 0)
        if not force and now - cached_at < _REMOTE_CACHE_TTL:
            continue
        content = _fetch_remote_skill(source)
        if content:
            _cache_path_for(source["name"]).write_text(content)
            meta[source["name"]] = now
            updated = True
    if updated:
        _save_meta(meta)


def load_remote_skill(name: str, auto_refresh: bool = True) -> str | None:
    """
    T-RAG-06: Load a remote skill by name.
    Returns cached content, triggers a background refresh if stale.
    Falls back to None if never fetched and network unavailable.
    """
    cache_file = _cache_path_for(name)
    meta = _load_meta()
    cached_at = meta.get(name, 0)
    is_stale = time.time() - cached_at >= _REMOTE_CACHE_TTL

    if is_stale and auto_refresh:
        # Find the source definition
        source = next((s for s in _REMOTE_SKILL_SOURCES if s["name"] == name), None)
        if source:
            content = _fetch_remote_skill(source)
            if content:
                cache_file.write_text(content)
                meta[name] = time.time()
                _save_meta(meta)
                return content

    if cache_file.exists():
        return cache_file.read_text()

    return None


def get_all_remote_skills(auto_refresh: bool = True) -> dict[str, str]:
    """
    T-RAG-06: Return all remote skills as {name: content} dict.
    Triggers refresh of any stale entries.
    """
    result: dict[str, str] = {}
    for source in _REMOTE_SKILL_SOURCES:
        content = load_remote_skill(source["name"], auto_refresh=auto_refresh)
        if content:
            result[source["name"]] = content
    return result

# Available skills
AVAILABLE_SKILLS = {
    "frontend-design": {
        "name": "frontend-design",
        "description": "Create distinctive, production-grade frontend interfaces with high design quality",
        "file": "frontend-design.md",
        "category": "frontend",
    },
    "web-design-guidelines": {
        "name": "web-design-guidelines",
        "description": "Review UI code for Web Interface Guidelines compliance",
        "file": "web-design-guidelines.md",
        "category": "review",
    },
    "react-best-practices": {
        "name": "react-best-practices",
        "description": "Apply React best practices for component architecture and state management",
        "file": "react-best-practices.md",
        "category": "frontend",
    },
    "composition-patterns": {
        "name": "composition-patterns",
        "description": "Advanced composition patterns for building flexible, reusable components",
        "file": "composition-patterns.md",
        "category": "patterns",
    },
    # ── Anthropic skills (T-RAG-07/09-13) ─────────────────────────────────
    "docx": {
        "name": "docx",
        "description": "Create, edit, and modify .docx Word documents with formatting, tables, images, and styles",
        "file": "docx.md",
        "category": "documents",
    },
    "pdf": {
        "name": "pdf",
        "description": "Read, extract, merge, split, create, watermark, fill forms, and OCR scan PDF files",
        "file": "pdf.md",
        "category": "documents",
    },
    "pptx": {
        "name": "pptx",
        "description": "Create/modify PowerPoint presentations with slides, layouts, speaker notes, and charts",
        "file": "pptx.md",
        "category": "documents",
    },
    "xlsx": {
        "name": "xlsx",
        "description": "Create/modify Excel files with formulas, charts, pivot tables, and data validation",
        "file": "xlsx.md",
        "category": "documents",
    },
    "mcp-builder": {
        "name": "mcp-builder",
        "description": "Generate Model Context Protocol servers from specifications or OpenAPI definitions",
        "file": "mcp-builder.md",
        "category": "mcp",
    },
    "webapp-testing": {
        "name": "webapp-testing",
        "description": "Write and run browser-based E2E, visual regression, and accessibility tests with Playwright",
        "file": "webapp-testing.md",
        "category": "testing",
    },
    # ── Vercel skills (T-RAG-08/20) ───────────────────────────────────────
    "vercel-deploy-claimable": {
        "name": "vercel-deploy-claimable",
        "description": "Deploy applications to Vercel with claimable preview URLs and project creation",
        "file": "vercel-deploy-claimable.md",
        "category": "deployment",
    },
    "react-native-guidelines": {
        "name": "react-native-guidelines",
        "description": "React Native best practices for mobile application development",
        "file": "react-native-skills.md",
        "category": "mobile",
    },
}


def load_skill(skill_name: str) -> str | None:
    """
    Load a skill file by name.

    Args:
        skill_name: Name of the skill to load

    Returns:
        Content of the skill file, or None if not found
    """
    skill = AVAILABLE_SKILLS.get(skill_name)
    if not skill:
        return None

    skill_path = SKILLS_DIR / skill["file"]
    if not skill_path.exists():
        return None

    return skill_path.read_text()


def load_all_skills() -> dict[str, str]:
    """
    Load all skills into a dictionary.

    Returns:
        Dictionary mapping skill names to their content
    """
    skills = {}
    for name, info in AVAILABLE_SKILLS.items():
        content = load_skill(name)
        if content:
            skills[name] = content
    return skills


def get_skill_info(skill_name: str) -> dict[str, Any] | None:
    """
    Get metadata about a skill.

    Args:
        skill_name: Name of the skill

    Returns:
        Dictionary with skill metadata, or None if not found
    """
    return AVAILABLE_SKILLS.get(skill_name)


def list_skills() -> list[dict[str, Any]]:
    """
    List all available skills with their metadata.

    Returns:
        List of skill metadata dictionaries
    """
    return list(AVAILABLE_SKILLS.values())


def get_frontend_skills() -> dict[str, str]:
    """
    Get all skills related to frontend development.
    T-RAG-06: Also includes dynamically fetched remote skills.

    Returns:
        Dictionary of frontend skills (local + remote)
    """
    frontend_skills = {}
    # Local bundled skills
    for name, info in AVAILABLE_SKILLS.items():
        if info.get("category") in ["frontend", "patterns", "testing", "deployment"]:
            content = load_skill(name)
            if content:
                frontend_skills[name] = content
    # T-RAG-06: Remote GitHub skills
    remote = get_all_remote_skills(auto_refresh=True)
    frontend_skills.update(remote)
    return frontend_skills


if __name__ == "__main__":
    # Demo: print all available skills
    print("Available Skills:")
    for skill in list_skills():
        print(f"  - {skill['name']}: {skill['description']}")
