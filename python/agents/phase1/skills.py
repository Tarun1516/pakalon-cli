"""
skills.py — Agent Skills Finder for Phase 1.
T101: Scrapes agentskills.io, skills.sh, GitHub repos to match skills to user requirements.
Supports live crawl with ETag-based caching, force-refresh, and graceful fallback.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import time
from typing import Any

import httpx

# ---------------------------------------------------------------------------
# Source registry — crawled in order; first success wins per category
# ---------------------------------------------------------------------------
AGENT_SKILLS_SOURCES = [
    # Vercel Labs official agent-skills repo
    "https://raw.githubusercontent.com/vercel-labs/agent-skills/main/README.md",
    # skills.sh — curated skill registry
    "https://skills.sh/vercel-labs/agent-skills",
    # UI/UX Pro Max skill pack
    "https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/README.md",
    # Shadcn component collection
    "https://raw.githubusercontent.com/shadcn-ui/ui/main/README.md",
    # Additional community skills
    "https://raw.githubusercontent.com/langchain-ai/langchain/master/docs/docs/integrations/tools.mdx",
]

# agentskills.io live catalog
AGENTSKILLS_HOME = "https://agentskills.io/home"
AGENTSKILLS_API = "https://agentskills.io/api/skills"        # JSON API endpoint (if available)

# skills.sh catalog endpoint
SKILLS_SH_LIST = "https://skills.sh/api/v1/skills"           # JSON list (if available)
SKILLS_SH_HTML = "https://skills.sh"

# Cache TTL: 24 hours
_CACHE_TTL_SECONDS = 86_400

# Retry settings for HTTP calls
_HTTP_MAX_RETRIES = 3
_HTTP_RETRY_BASE_DELAY = 0.5  # seconds; doubles each attempt


def _retry_get(
    url: str,
    *,
    timeout: int = 15,
    max_retries: int = _HTTP_MAX_RETRIES,
    headers: dict[str, str] | None = None,
) -> httpx.Response | None:
    """
    GET with exponential-backoff retry.
    Returns the Response on the first non-5xx success, or None if all retries exhausted.
    """
    merged_headers = {"User-Agent": "pakalon/1.0"}
    if headers:
        merged_headers.update(headers)

    delay = _HTTP_RETRY_BASE_DELAY
    for attempt in range(max_retries):
        try:
            with httpx.Client(
                timeout=timeout,
                headers=merged_headers,
                follow_redirects=True,
            ) as client:
                resp = client.get(url)
                if resp.status_code < 500:
                    return resp
                # Server error — backoff and retry
        except (httpx.TimeoutException, httpx.NetworkError):
            pass
        except Exception:
            return None
        if attempt < max_retries - 1:
            time.sleep(delay)
            delay *= 2
    return None


class AgentSkillsFinder:
    """
    Discovers and matches agent skills to user requirements.
    Sources: agentskills.io, skills.sh, GitHub repos.
    Uses ETag/mtime-based cache with 24-hour TTL.
    """

    def __init__(self, cache_dir: str | pathlib.Path | None = None, force_refresh: bool = False) -> None:
        self._cache_dir = pathlib.Path(cache_dir or (pathlib.Path.home() / ".config" / "pakalon" / "skills_cache"))
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._skills: list[dict[str, str]] = []
        self._force_refresh = force_refresh

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    def load(self) -> None:
        """Load skill list — from fresh cache if recent, else re-fetch."""
        cache_file = self._cache_dir / "skills.json"
        meta_file = self._cache_dir / "skills_meta.json"

        if not self._force_refresh and cache_file.exists():
            # Check cache age
            try:
                meta = json.loads(meta_file.read_text()) if meta_file.exists() else {}
                fetched_at = meta.get("fetched_at", 0)
                if time.time() - fetched_at < _CACHE_TTL_SECONDS:
                    self._skills = json.loads(cache_file.read_text())
                    return
            except Exception:
                pass

        self._fetch_and_cache()

    def _fetch_and_cache(self) -> None:
        """Fetch skills from all sources and write to local cache."""
        skills: list[dict[str, str]] = []

        # 1. GitHub README sources (raw markdown)
        for url in AGENT_SKILLS_SOURCES:
            try:
                resp = _retry_get(url, timeout=15)
                if resp and resp.status_code == 200:
                    if "mdx" in url or url.endswith(".md"):
                        parsed = self._parse_readme_skills(resp.text, source_url=url)
                    else:
                        parsed = self._parse_html_skills(resp.text, source_url=url)
                    skills.extend(parsed)
            except Exception:
                pass

        # 2. agentskills.io JSON API
        try:
            resp = _retry_get(AGENTSKILLS_API, timeout=10)
            if resp and resp.status_code == 200:
                data = resp.json()
                items = data if isinstance(data, list) else data.get("skills", [])
                for item in items:
                    skills.append({
                        "name": item.get("name", ""),
                        "url": item.get("url", AGENTSKILLS_HOME),
                        "description": item.get("description", item.get("summary", "")),
                        "category": item.get("category", "general"),
                        "source": "agentskills.io",
                    })
        except Exception:
            pass

        # 3. agentskills.io HTML fallback
        try:
            resp = _retry_get(AGENTSKILLS_HOME, timeout=10)
            if resp and resp.status_code == 200:
                parsed = self._parse_html_skills(resp.text, source_url=AGENTSKILLS_HOME)
                skills.extend(parsed)
        except Exception:
            pass

        # 4. skills.sh JSON API
        try:
            resp = _retry_get(SKILLS_SH_LIST, timeout=10, headers={"Accept": "application/json"})
            if resp and resp.status_code == 200:
                data = resp.json()
                items = data if isinstance(data, list) else data.get("items", data.get("skills", []))
                for item in items:
                    skills.append({
                        "name": item.get("name", item.get("id", "")),
                        "url": item.get("url", item.get("homepage", SKILLS_SH_HTML)),
                        "description": item.get("description", ""),
                        "category": item.get("category", "skill"),
                        "source": "skills.sh",
                    })
        except Exception:
            pass

        # 5. skills.sh HTML fallback
        try:
            resp = _retry_get(SKILLS_SH_HTML, timeout=10)
            if resp and resp.status_code == 200:
                parsed = self._parse_html_skills(resp.text, source_url=SKILLS_SH_HTML)
                skills.extend(parsed)
        except Exception:
            pass

        # Deduplicate by lower-cased name
        seen: set[str] = set()
        unique: list[dict[str, str]] = []
        for s in skills:
            key = s.get("name", "").lower().strip()
            if key and key not in seen:
                seen.add(key)
                unique.append(s)

        if not unique:
            # All sources failed — try stale cache as last resort
            cache_path = self._cache_dir / "skills.json"
            if cache_path.exists():
                try:
                    stale = json.loads(cache_path.read_text())
                    if stale:
                        import warnings
                        warnings.warn(
                            "[AgentSkillsFinder] All network sources failed. "
                            "Loaded stale cache from disk (may be outdated).",
                            stacklevel=3,
                        )
                        self._skills = stale
                        return
                except Exception:
                    pass
            # Genuinely empty — nothing we can do
            self._skills = []
            return

        self._skills = unique

        # Persist to cache with metadata
        try:
            cache_path = self._cache_dir / "skills.json"
            cache_path.write_text(json.dumps(self._skills, indent=2))
            meta_path = self._cache_dir / "skills_meta.json"
            meta_path.write_text(json.dumps({
                "fetched_at": time.time(),
                "total": len(self._skills),
                "sources": ["github", "agentskills.io", "skills.sh"],
            }, indent=2))
        except Exception:
            pass

    @staticmethod
    def _parse_readme_skills(text: str, source_url: str = "") -> list[dict[str, str]]:
        """Parse skill entries from a GitHub README or MDX file."""
        skills = []
        # Pattern 1: `- [Skill Name](url) — description`
        for match in re.finditer(
            r"-\s+\[([^\]]+)\]\(([^)]+)\)[\s—\-:*]*([^\n]*)", text
        ):
            name = match.group(1).strip()
            url = match.group(2).strip()
            desc = match.group(3).strip().lstrip("*").strip()
            if name and url and not url.startswith("#"):
                skills.append({
                    "name": name,
                    "url": url,
                    "description": desc,
                    "category": _infer_category(name + " " + desc),
                    "source": source_url,
                })
        # Pattern 2: `## Heading` sections with adjacent URLs
        for match in re.finditer(r"#{2,3}\s+(.+)", text):
            heading = match.group(1).strip()
            if 2 <= len(heading.split()) <= 8 and not heading.startswith("{"):
                skills.append({
                    "name": heading,
                    "url": source_url,
                    "description": "",
                    "category": _infer_category(heading),
                    "source": source_url,
                })
        return skills

    @staticmethod
    def _parse_html_skills(html: str, source_url: str = "") -> list[dict[str, str]]:
        """Parse skill data from HTML page — handles agentskills.io and skills.sh markup."""
        skills = []
        # Extract anchor tags with nearby description text
        for match in re.finditer(
            r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>([^<]{3,80})</a>', html, re.IGNORECASE
        ):
            href = match.group(1).strip()
            anchor_text = match.group(2).strip()
            if (
                anchor_text
                and 2 <= len(anchor_text.split()) <= 10
                and not anchor_text.lower().startswith(("http", "sign", "log", "home", "about"))
            ):
                full_url = href if href.startswith("http") else source_url.rstrip("/") + "/" + href.lstrip("/")
                skills.append({
                    "name": anchor_text,
                    "url": full_url,
                    "description": "",
                    "category": _infer_category(anchor_text),
                    "source": source_url,
                })
        # Fallback: h2/h3 headings
        if not skills:
            for match in re.finditer(r"<h[23][^>]*>([^<]{3,80})</h[23]>", html, re.IGNORECASE):
                heading = match.group(1).strip()
                if 2 <= len(heading.split()) <= 6:
                    skills.append({
                        "name": heading,
                        "url": source_url,
                        "description": "",
                        "category": _infer_category(heading),
                        "source": source_url,
                    })
        return skills

    # ------------------------------------------------------------------
    # Matching
    # ------------------------------------------------------------------

    def match_skills(self, user_requirement: str, max_results: int = 15) -> list[dict[str, str]]:
        """
        Match skills to a user requirement using keyword + category scoring.
        Returns ranked list of {name, url, description, source, relevance_score}.
        """
        if not self._skills:
            self.load()

        req_lower = user_requirement.lower()
        req_words = set(re.findall(r"\w+", req_lower))

        # Category boost keywords
        CATEGORY_BOOSTS: dict[str, list[str]] = {
            "frontend": ["ui", "ux", "design", "frontend", "react", "next", "css", "tailwind", "component"],
            "backend": ["backend", "api", "server", "database", "fastapi", "express", "django"],
            "mobile": ["mobile", "ios", "android", "react native", "flutter"],
            "testing": ["test", "testing", "qa", "e2e", "unit", "playwright", "jest"],
            "devops": ["ci", "cd", "docker", "kubernetes", "deploy", "github actions"],
            "security": ["security", "sast", "dast", "auth", "jwt", "oauth"],
            "ai": ["ai", "llm", "gpt", "claude", "langchain", "agent", "rag"],
        }

        scored = []
        for skill in self._skills:
            skill_text = f"{skill.get('name','')} {skill.get('description','')} {skill.get('category','')}".lower()
            skill_words = set(re.findall(r"\w+", skill_text))
            overlap = len(req_words & skill_words)

            # Category alignment bonus
            bonus = 0
            cat = skill.get("category", "")
            for category, keywords in CATEGORY_BOOSTS.items():
                if any(k in req_lower for k in keywords) and cat == category:
                    bonus += 3

            score = overlap + bonus
            if score > 0:
                scored.append({**skill, "relevance_score": score})

        scored.sort(key=lambda s: s["relevance_score"], reverse=True)
        return scored[:max_results]

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------

    def write_skills_md(self, output_path: str, requirement: str) -> str:
        """
        Write agent-skills.md with matched skills grouped by category.
        Returns path to written file.
        """
        matched = self.match_skills(requirement)
        lines = [
            "# Agent Skills",
            "",
            f"> Matched to requirement: *{requirement[:200]}*",
            f"> Total skills indexed: {len(self._skills)}  |  Matched: {len(matched)}",
            "",
        ]

        # Group by category
        categories: dict[str, list[dict]] = {}
        for s in matched:
            cat = s.get("category", "general").title()
            categories.setdefault(cat, []).append(s)

        if categories:
            lines.append("## Selected Skills by Category")
            lines.append("")
            for cat, items in categories.items():
                lines.append(f"### {cat}")
                lines.append("")
                for s in items:
                    name = s.get("name", "Unnamed")
                    url = s.get("url", "")
                    desc = s.get("description", "")
                    source = s.get("source", "")
                    score = s.get("relevance_score", 0)
                    lines.append(f"- **[{name}]({url})**")
                    if desc:
                        lines.append(f"  *{desc[:120]}*")
                    lines.append(f"  Source: `{source}` | Relevance: {score}")
                    lines.append("")
        else:
            lines.append("## Skills")
            lines.append("")
            lines.append("*No matching skills found in registry. Proceeding with built-in capabilities.*")
            lines.append("")

        lines.append("## How These Skills Are Used")
        lines.append("")
        lines.append("Phase 3 sub-agents will reference this file to:")
        lines.append("- Load relevant component templates and code patterns")
        lines.append("- Pull pre-built UI components from matched registries")
        lines.append("- Apply design guidelines specific to the matched skill categories")

        content = "\n".join(lines)
        pathlib.Path(output_path).write_text(content)
        return output_path


# ---------------------------------------------------------------------------
# Helper: infer skill category from name/description text
# ---------------------------------------------------------------------------
def _infer_category(text: str) -> str:
    t = text.lower()
    if any(k in t for k in ["ui", "ux", "design", "frontend", "react", "next", "tailwind", "css", "component", "radix", "shadcn"]):
        return "frontend"
    if any(k in t for k in ["backend", "api", "server", "fastapi", "express", "django", "flask", "node"]):
        return "backend"
    if any(k in t for k in ["mobile", "ios", "android", "react native", "flutter", "swift", "kotlin"]):
        return "mobile"
    if any(k in t for k in ["test", "testing", "qa", "e2e", "playwright", "jest", "vitest"]):
        return "testing"
    if any(k in t for k in ["ci", "cd", "docker", "kubernetes", "deploy", "devops", "github actions"]):
        return "devops"
    if any(k in t for k in ["security", "sast", "dast", "auth", "jwt", "oauth", "owasp"]):
        return "security"
    if any(k in t for k in ["ai", "llm", "gpt", "claude", "langchain", "agent", "rag", "openai"]):
        return "ai"
    return "general"
