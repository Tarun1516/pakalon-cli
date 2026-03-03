"""
registry_rag.py — Phase 3 RegistryRAG: component registry search with RAG.
T109: Load registry.json, embed descriptions, search by query, fetch component docs.
T-CLI-12: Web scraping integration for UI component libraries.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
from typing import Any


class RegistryRAG:
    """
    RAG over a component registry (shadcn/ui, Radix, etc.).
    Stores embeddings in ChromaDB; returns top-K matching components.
    """

    REGISTRY_SOURCES = [
        "https://ui.shadcn.com/registry.json",
        "https://registry.npmmirror.com/-/v1/search?text=react+ui+component&size=50",
    ]

    # T-CLI-12: All required UI component library websites for web scraping (12+ sites)
    WEB_COMPONENT_SITES = [
        {
            "name": "shadcn/ui",
            "url": "https://ui.shadcn.com/docs/components/accordion",
            "base_url": "https://ui.shadcn.com",
            "tag": "shadcn",
        },
        {
            "name": "DaisyUI",
            "url": "https://daisyui.com/components/",
            "base_url": "https://daisyui.com",
            "tag": "daisyui",
        },
        {
            "name": "Preline UI",
            "url": "https://preline.co/docs/index.html",
            "base_url": "https://preline.co",
            "tag": "preline",
        },
        {
            "name": "ReactBits",
            "url": "https://reactbits.dev",
            "base_url": "https://reactbits.dev",
            "tag": "reactbits",
        },
        {
            "name": "Radix UI",
            "url": "https://www.radix-ui.com/primitives/docs/overview/introduction",
            "base_url": "https://www.radix-ui.com",
            "tag": "radix",
        },
        {
            "name": "Headless UI",
            "url": "https://headlessui.com",
            "base_url": "https://headlessui.com",
            "tag": "headlessui",
        },
        # Additional required sites
        {
            "name": "Aceternity UI",
            "url": "https://ui.aceternity.com/components",
            "base_url": "https://ui.aceternity.com",
            "tag": "aceternity",
        },
        {
            "name": "Magic UI",
            "url": "https://magicui.design/docs",
            "base_url": "https://magicui.design",
            "tag": "magicui",
        },
        {
            "name": "Float UI",
            "url": "https://floatui.com/components",
            "base_url": "https://floatui.com",
            "tag": "floatui",
        },
        {
            "name": "Ripple UI",
            "url": "https://www.ripple-ui.com",
            "base_url": "https://www.ripple-ui.com",
            "tag": "rippleui",
        },
        {
            "name": "HyperUI",
            "url": "https://www.hyperui.dev",
            "base_url": "https://www.hyperui.dev",
            "tag": "hyperui",
        },
        {
            "name": "Tailwind Components",
            "url": "https://tailwindcomponents.com",
            "base_url": "https://tailwindcomponents.com",
            "tag": "tailwindcomponents",
        },
        {
            "name": "Lightswind",
            "url": "https://lightswind.com/components",
            "base_url": "https://lightswind.com",
            "tag": "lightswind",
        },
        {
            "name": "Flowbite",
            "url": "https://flowbite.com/docs/getting-started/introduction/",
            "base_url": "https://flowbite.com",
            "tag": "flowbite",
        },
        {
            "name": "NextUI",
            "url": "https://nextui.org/docs/components/button",
            "base_url": "https://nextui.org",
            "tag": "nextui",
        },
        {
            "name": "Mantine",
            "url": "https://mantine.dev/core/button/",
            "base_url": "https://mantine.dev",
            "tag": "mantine",
        },
        # Additional sites from requirements (T-CLI-12)
        {
            "name": "TailwindFlex",
            "url": "https://tailwindflex.com",
            "base_url": "https://tailwindflex.com",
            "tag": "tailwindflex",
        },
        {
            "name": "Dribbble",
            "url": "https://dribbble.com/tags/ui-component",
            "base_url": "https://dribbble.com",
            "tag": "dribbble",
        },
        {
            "name": "Spline",
            "url": "https://spline.design",
            "base_url": "https://spline.design",
            "tag": "spline",
        },
        {
            "name": "Aura UI",
            "url": "https://aura.build/browse/components",
            "base_url": "https://aura.build",
            "tag": "aura",
        },
        {
            "name": "Shadcn Studio",
            "url": "https://shadcnstudio.com",
            "base_url": "https://shadcnstudio.com",
            "tag": "shadcnstudio",
        },
        {
            "name": "TweakCN",
            "url": "https://tweakcn.com",
            "base_url": "https://tweakcn.com",
            "tag": "tweakcn",
        },
    ]

    def __init__(self, registry_path: str | None = None, cache_dir: str | None = None):
        self.registry_path = registry_path
        self.cache_dir = pathlib.Path(cache_dir or os.path.expanduser("~/.config/pakalon/registry"))
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._components: list[dict] = []
        self._chroma: Any = None

    # ------------------------------------------------------------------

    def load(self, force_reload: bool = False) -> int:
        """Load registry from local path or remote URL. Returns component count."""
        cache_file = self.cache_dir / "registry.json"

        # Use provided path
        if self.registry_path and pathlib.Path(self.registry_path).exists():
            raw = json.loads(pathlib.Path(self.registry_path).read_text())
            self._components = self._normalize(raw)
            cache_file.write_text(json.dumps(self._components))
            return len(self._components)

        # Use disk cache
        if not force_reload and cache_file.exists():
            self._components = json.loads(cache_file.read_text())
            return len(self._components)

        # Fetch from remote
        self._components = []
        try:
            import httpx
            for url in self.REGISTRY_SOURCES:
                try:
                    resp = httpx.get(url, timeout=10)
                    data = resp.json()
                    self._components.extend(self._normalize(data))
                except Exception:
                    pass
        except ImportError:
            pass

        # T-CLI-12: augment with scraped component sites
        scraped = self.scrape_component_sites()
        self._components.extend(scraped)

        cache_file.write_text(json.dumps(self._components))
        return len(self._components)

    def _normalize(self, data: Any) -> list[dict]:
        """Normalize different registry formats into [{name, description, docs_url, tags}]."""
        components: list[dict] = []
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    components.append({
                        "name": item.get("name", ""),
                        "description": item.get("description", ""),
                        "docs_url": item.get("docs", item.get("homepage", "")),
                        "tags": item.get("tags", item.get("keywords", [])),
                    })
        elif isinstance(data, dict):
            items = data.get("components", data.get("items", data.get("objects", [])))
            return self._normalize(items)
        return components

    def scrape_component_sites(self) -> list[dict]:
        """
        T-CLI-12: Scrape UI component library websites using Firecrawl.
        Returns list of normalized component dicts.
        Falls back gracefully to httpx if Firecrawl is unavailable.
        """
        scraped: list[dict] = []
        fc_api_key = os.environ.get("FIRECRAWL_API_KEY", "")

        for site in self.WEB_COMPONENT_SITES:
            site_name = site["name"]
            site_url = site["url"]
            tag = site.get("tag", site_name.lower())
            cache_key = self.cache_dir / f"scraped_{tag}.json"

            # Use cached scrape (expires after 24h)
            import time as _time
            if cache_key.exists():
                age = _time.time() - cache_key.stat().st_mtime
                if age < 86400:  # 24 hours
                    try:
                        cached = json.loads(cache_key.read_text())
                        scraped.extend(cached)
                        continue
                    except Exception:
                        pass

            site_components: list[dict] = []

            # Try Firecrawl scrape
            if fc_api_key:
                try:
                    from ....tools.firecrawl import FirecrawlTool
                    fc = FirecrawlTool()
                    content = fc.scrape(site_url)
                    if content:
                        # Extract component names from scraped markdown
                        import re
                        # Look for component headings like "## Button" or "### Card"
                        headings = re.findall(r"#{1,3}\s+([A-Z][a-zA-Z\s]+)", content)
                        for heading in headings[:20]:
                            heading = heading.strip()
                            if len(heading) < 30 and len(heading) > 2:
                                site_components.append({
                                    "name": f"{site_name}/{heading}",
                                    "description": f"{heading} component from {site_name}",
                                    "docs_url": site_url,
                                    "tags": [tag, "ui", "component", heading.lower()],
                                    "source": site_name,
                                })
                except Exception:
                    pass

            # Fallback: HTTP scrape if Firecrawl not available
            if not site_components:
                try:
                    import httpx
                    import re
                    resp = httpx.get(site_url, timeout=10, follow_redirects=True)
                    # Extract h2/h3 headings from HTML
                    headings = re.findall(r"<h[23][^>]*>([^<]+)</h[23]>", resp.text)
                    for heading in headings[:20]:
                        heading = heading.strip()
                        if len(heading) < 30 and len(heading) > 2:
                            site_components.append({
                                "name": f"{site_name}/{heading}",
                                "description": f"{heading} component from {site_name}",
                                "docs_url": site_url,
                                "tags": [tag, "ui", "component", heading.lower()],
                                "source": site_name,
                            })
                except Exception:
                    pass

            # Always add the library itself as an entry
            if not site_components:
                site_components.append({
                    "name": site_name,
                    "description": f"UI component library: {site_name}",
                    "docs_url": site["base_url"],
                    "tags": [tag, "ui", "component-library"],
                    "source": site_name,
                })

            scraped.extend(site_components)
            try:
                cache_key.write_text(json.dumps(site_components))
            except Exception:
                pass

        return scraped

    # ------------------------------------------------------------------

    def search(self, query: str, top_k: int = 10) -> list[dict]:
        """Search components by query. ChromaDB is primary; keyword search is fallback."""
        if not self._components:
            self.load()

        # Try ChromaDB semantic search
        try:
            ChromaClient = self._import_chroma_client()
            if ChromaClient is not None:
                if self._chroma is None:
                    self._chroma = ChromaClient(collection_name="pakalon_registry")
                    self._index_to_chroma()
                elif self._chroma.count() == 0:
                    # Re-index if collection was wiped
                    self._index_to_chroma()
                results = self._chroma.query(query, n_results=top_k)
                if results:
                    ids = {r.get("id") for r in results}
                    # Map results back to component dicts, preserving chroma rank order
                    id_to_comp = {c.get("name"): c for c in self._components}
                    ordered = []
                    for r in results:
                        rid = r.get("id", "")
                        if rid in id_to_comp:
                            ordered.append(id_to_comp[rid])
                    # Supplement with any remaining comps not in results (e.g. hash-id stored)
                    if not ordered:
                        ordered = [c for c in self._components if c.get("name") in ids]
                    if ordered:
                        return ordered[:top_k]
        except Exception:
            pass

        # Keyword fallback
        q_lower = query.lower()
        scored = []
        for comp in self._components:
            score = 0
            for w in q_lower.split():
                if w in comp.get("name", "").lower():
                    score += 3
                if w in comp.get("description", "").lower():
                    score += 1
                for tag in comp.get("tags", []):
                    if w in str(tag).lower():
                        score += 2
            if score > 0:
                scored.append((score, comp))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [c for _, c in scored[:top_k]]

    @staticmethod
    def _import_chroma_client() -> Any:
        """Try all known import paths for ChromaClient. Returns the class or None."""
        try:
            from python.memory.chroma_client import ChromaClient  # type: ignore
            return ChromaClient
        except ImportError:
            pass
        try:
            from memory.chroma_client import ChromaClient  # type: ignore
            return ChromaClient
        except ImportError:
            pass
        try:
            import importlib
            import sys
            import pathlib as _pl
            # Resolve relative to this file: ../../memory/chroma_client
            _here = _pl.Path(__file__).resolve().parent
            _mem = str(_here.parent.parent / "memory")
            if _mem not in sys.path:
                sys.path.insert(0, _mem)
            mod = importlib.import_module("chroma_client")
            return mod.ChromaClient
        except Exception:
            return None

    def _index_to_chroma(self) -> None:
        """Index all components into ChromaDB. Uses stable component name as doc_id."""
        if self._chroma is None:
            return
        for comp in self._components:
            name = comp.get("name") or ""
            doc_text = f"{name} {comp.get('description', '')} {' '.join(str(t) for t in comp.get('tags', []))}"
            doc_id = name if name else hashlib.md5(doc_text.encode()).hexdigest()
            try:
                self._chroma.upsert(
                    doc_id=doc_id,
                    document=doc_text,
                    metadata={
                        "docs_url": comp.get("docs_url", ""),
                        "source": comp.get("source", ""),
                        "tags": ",".join(str(t) for t in comp.get("tags", [])),
                    },
                )
            except Exception:
                pass

    def fetch(self, component_name: str) -> dict | None:
        """Fetch component docs/README from its docs_url."""
        comp = next((c for c in self._components if c.get("name") == component_name), None)
        if not comp:
            return None
        docs_url = comp.get("docs_url", "")
        if not docs_url:
            return comp
        try:
            import httpx
            resp = httpx.get(docs_url, timeout=10, follow_redirects=True)
            comp["docs_content"] = resp.text[:3000]
        except Exception:
            pass
        return comp

    def fetch_full_source(self, component_name: str, max_chars: int = 4000) -> dict:
        """
        Fetch the full source code and usage examples for a component.

        Strategy:
        1. Try Firecrawl (returns clean markdown with code blocks preserved).
        2. Fall back to httpx + regex extraction of <code>/<pre> blocks.
        3. Final fallback: return whatever fetch() already has.

        Returns:
            {
                "name": str,
                "docs_url": str,
                "source_markdown": str,   # clean markdown representation
                "code_blocks": list[str], # extracted code/usage examples
                "raw_snippet": str,       # first max_chars of source_markdown
            }
        """
        comp = next((c for c in self._components if c.get("name") == component_name), None)
        docs_url = (comp or {}).get("docs_url", "")
        result: dict = {
            "name": component_name,
            "docs_url": docs_url,
            "source_markdown": "",
            "code_blocks": [],
            "raw_snippet": "",
        }
        if not docs_url:
            return result

        fc_api_key = os.environ.get("FIRECRAWL_API_KEY", "")
        markdown_content = ""

        # -- (1) Firecrawl: clean markdown that preserves fenced code blocks ------
        if fc_api_key:
            try:
                from ....tools.firecrawl import FirecrawlTool  # type: ignore
                fc = FirecrawlTool()
                markdown_content = fc.scrape(docs_url) or ""
            except Exception:
                pass

        # -- (2) httpx fallback: extract <pre>/<code> blocks from raw HTML --------
        if not markdown_content:
            try:
                import httpx, re
                resp = httpx.get(docs_url, timeout=12, follow_redirects=True)
                html = resp.text

                # Strip script/style noise
                html_clean = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.S)

                # Extract <pre> / <code> blocks
                code_raw = re.findall(r"<pre[^>]*>(.*?)</pre>|<code[^>]*>(.*?)</code>", html_clean, flags=re.S)
                blocks: list[str] = []
                for pre, code in code_raw:
                    raw = pre or code
                    # Strip inner HTML tags
                    clean_block = re.sub(r"<[^>]+>", "", raw).strip()
                    if clean_block and len(clean_block) > 10:
                        blocks.append(clean_block)

                # Convert headings to markdown for context
                h_text = re.sub(r"<h([1-3])[^>]*>(.*?)</h\1>", lambda m: "#" * int(m.group(1)) + " " + re.sub(r"<[^>]+>", "", m.group(2)), html_clean, flags=re.S)
                para_text = re.sub(r"<p[^>]*>(.*?)</p>", lambda m: re.sub(r"<[^>]+>", "", m.group(1)) + "\n\n", h_text, flags=re.S)
                markdown_content = re.sub(r"<[^>]+>", "", para_text)

                if blocks:
                    result["code_blocks"] = blocks[:8]  # keep at most 8 code blocks
            except Exception:
                pass

        # -- Extract fenced code blocks from Firecrawl markdown ------------------
        if markdown_content and not result["code_blocks"]:
            import re
            fenced = re.findall(r"```(?:[a-z]*)?\n(.*?)```", markdown_content, flags=re.S)
            result["code_blocks"] = [b.strip() for b in fenced if b.strip()][:8]

        result["source_markdown"] = markdown_content[:max_chars] if markdown_content else ""
        result["raw_snippet"] = result["source_markdown"][:max_chars]

        # Cache onto the component dict for inject_as_context reuse
        if comp is not None:
            comp["_full_source"] = result

        return result

    # ------------------------------------------------------------------
    # E-01: user_url_append — let users add their own component sites at runtime
    # ------------------------------------------------------------------

    def user_url_append(self, url: str, name: str | None = None, tag: str | None = None) -> int:
        """
        Append a user-provided URL to WEB_COMPONENT_SITES and scrape it immediately.

        Args:
            url:  A URL to a UI component library or any reference site.
            name: Human-readable label (defaults to hostname).
            tag:  Short tag for search filtering (defaults to hostname).

        Returns:
            Number of components added from this URL.
        """
        import urllib.parse

        hostname = urllib.parse.urlparse(url).hostname or url
        _name = name or hostname
        _tag = (tag or hostname.replace(".", "_").replace("-", "_"))

        # Add to runtime site list so subsequent reloads include it
        self.__class__.WEB_COMPONENT_SITES.append({
            "name": _name,
            "url": url,
            "base_url": f"{urllib.parse.urlparse(url).scheme}://{hostname}",
            "tag": _tag,
        })

        # Persist to user-extras file (survives restarts)
        extras_path = self.cache_dir / "user_urls.json"
        existing: list[dict] = []
        try:
            if extras_path.exists():
                existing = json.loads(extras_path.read_text())
        except Exception:
            pass
        existing.append({"name": _name, "url": url, "tag": _tag})
        try:
            extras_path.write_text(json.dumps(existing, indent=2))
        except Exception:
            pass

        # Scrape immediately and extend in-memory components
        before = len(self._components)
        try:
            new_comps = self.scrape_component_sites()
            # Only keep newly-added entries (those matching our new tag)
            added = [c for c in new_comps if _tag in c.get("tags", [])]
            self._components.extend(added)
            # Re-index to chroma if available
            if self._chroma:
                self._index_to_chroma()
        except Exception:
            pass
        return len(self._components) - before

    def load_user_urls(self) -> None:
        """Load persisted user-provided URLs on startup."""
        extras_path = self.cache_dir / "user_urls.json"
        if not extras_path.exists():
            return
        try:
            entries: list[dict] = json.loads(extras_path.read_text())
            existing_names = {s["name"] for s in self.__class__.WEB_COMPONENT_SITES}
            import urllib.parse
            for e in entries:
                if e.get("name") not in existing_names:
                    hostname = urllib.parse.urlparse(e["url"]).hostname or e["url"]
                    self.__class__.WEB_COMPONENT_SITES.append({
                        "name": e["name"],
                        "url": e["url"],
                        "base_url": f"{urllib.parse.urlparse(e['url']).scheme}://{hostname}",
                        "tag": e.get("tag", "user"),
                    })
        except Exception:
            pass

    # ------------------------------------------------------------------
    # E-02: inject_as_context — format top results as an LLM context block
    # ------------------------------------------------------------------

    def inject_as_context(
        self,
        query: str,
        top_k: int = 5,
        include_docs: bool = False,
        include_source: bool = False,
        max_source_chars: int = 2000,
    ) -> str:
        """
        Search the registry for `query` and return a formatted markdown
        block suitable for injection into an LLM system prompt.

        Args:
            query:            The current design/component requirement.
            top_k:            How many results to include.
            include_docs:     Fetch and include the first 500 chars of each docs_url (HTML).
            include_source:   Fetch full source/usage examples via fetch_full_source()
                              and inject up to `max_source_chars` of code blocks.
            max_source_chars: Hard cap on injected source per component (default: 2000).

        Returns:
            A markdown-formatted "Component Library References" block.
        """
        matches = self.search(query, top_k=top_k)
        if not matches:
            return "<!-- No registry components matched -->"

        lines: list[str] = ["## Component Library References\n"]
        for i, comp in enumerate(matches, start=1):
            name = comp.get("name", f"Component {i}")
            desc = comp.get("description", "")
            url = comp.get("docs_url", "")
            tags = ", ".join(comp.get("tags", []))
            lines.append(f"### {i}. {name}")
            if desc:
                lines.append(f"*{desc}*")
            if tags:
                lines.append(f"Tags: `{tags}`")
            if url:
                lines.append(f"Docs: {url}")

            if include_source and url:
                # Full source injection: prefer cached result, otherwise fetch
                cached = comp.get("_full_source")
                source_data = cached if cached else self.fetch_full_source(name, max_chars=max_source_chars)
                code_blocks = source_data.get("code_blocks", [])
                snippet = source_data.get("raw_snippet", "")

                if code_blocks:
                    lines.append("\n**Usage examples:**")
                    total = 0
                    for block in code_blocks:
                        if total + len(block) > max_source_chars:
                            break
                        lines.append(f"```\n{block}\n```")
                        total += len(block)
                elif snippet:
                    lines.append(f"\n**Source excerpt:**\n{snippet[:max_source_chars]}")

            elif include_docs and url:
                # Legacy: raw HTML snippet (500 chars)
                fetched = self.fetch(name)
                content = (fetched or {}).get("docs_content", "")
                if content:
                    lines.append(f"\n```\n{content[:500]}\n```")

            lines.append("")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # E-03: update_registry — scrape / refresh registry from all sources
    # ------------------------------------------------------------------

    def update_registry(self, extra_urls: list[str] | None = None, force: bool = False) -> int:
        """
        Re-scrape all WEB_COMPONENT_SITES (and optional extra_urls) and
        persist the refreshed registry to disk. Returns the total component count.

        Args:
            extra_urls: Additional user-provided URLs to add before scraping.
            force:      If True, bypass the 24-hour scrape cache.
        """
        if extra_urls:
            for url in extra_urls:
                self.user_url_append(url)

        if force:
            # Clear cached site scrapes so scrape_component_sites re-fetches
            for f in self.cache_dir.glob("scraped_*.json"):
                try:
                    f.unlink()
                except Exception:
                    pass

        # Full reload from all sources + rescrape
        cache_file = self.cache_dir / "registry.json"
        if force and cache_file.exists():
            try:
                cache_file.unlink()
            except Exception:
                pass

        return self.load(force_reload=True)
