"""
firecrawl.py — Firecrawl web scraping tool for Pakalon agents.
T097: FirecrawlTool with scrape/crawl using firecrawl-py SDK.
"""
from __future__ import annotations

import os
from typing import Any

try:
    from firecrawl import FirecrawlApp  # type: ignore
    FIRECRAWL_AVAILABLE = True
except ImportError:
    FIRECRAWL_AVAILABLE = False

import httpx


class FirecrawlTool:
    """
    Wraps the firecrawl-py SDK for web scraping and crawling.
    Falls back to basic httpx GET if firecrawl-py not installed.
    """

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key or os.environ.get("FIRECRAWL_API_KEY", "")
        self._app: Any = None
        if FIRECRAWL_AVAILABLE and self._api_key:
            self._app = FirecrawlApp(api_key=self._api_key)

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def scrape(
        self,
        url: str,
        extract_schema: dict[str, Any] | None = None,
        formats: list[str] | None = None,
    ) -> str:
        """
        Scrape a single URL and return cleaned markdown.
        If extract_schema provided, returns structured JSON as string.
        Falls back to httpx if firecrawl not available.
        """
        if self._app is not None:
            params: dict[str, Any] = {"formats": formats or ["markdown"]}
            if extract_schema:
                params["extract"] = {"schema": extract_schema}
            try:
                result = self._app.scrape_url(url, params=params)
                if extract_schema:
                    import json
                    extracted = result.get("extract") or result.get("json") or {}
                    return json.dumps(extracted, ensure_ascii=False, indent=2)
                return result.get("markdown") or result.get("content") or ""
            except Exception as e:
                return f"[Firecrawl error: {e}]"

        # Fallback
        return self._httpx_scrape(url)

    def crawl(
        self,
        url: str,
        depth: int = 2,
        limit: int = 20,
    ) -> list[dict[str, str]]:
        """
        Crawl a website up to `depth` levels.
        Returns list of {url, markdown} dicts.
        """
        if self._app is not None:
            try:
                result = self._app.crawl_url(
                    url,
                    params={
                        "crawlerOptions": {"maxDepth": depth, "limit": limit},
                        "pageOptions": {"onlyMainContent": True},
                    },
                )
                pages = result.get("data") or []
                return [
                    {"url": p.get("url", ""), "markdown": p.get("markdown") or p.get("content") or ""}
                    for p in pages
                ]
            except Exception as e:
                return [{"url": url, "markdown": f"[Crawl error: {e}]"}]

        # Fallback: single page
        content = self._httpx_scrape(url)
        return [{"url": url, "markdown": content}]

    def extract_design(self, url: str) -> dict[str, Any]:
        """
        Extract design tokens from a website (colors, fonts, layout).
        Used by /web command.
        """
        schema = {
            "type": "object",
            "properties": {
                "colors": {"type": "array", "items": {"type": "string"}},
                "fonts": {"type": "array", "items": {"type": "string"}},
                "components": {"type": "array", "items": {"type": "string"}},
                "layout": {"type": "string"},
                "brand_style": {"type": "string"},
            },
        }
        raw = self.scrape(url, extract_schema=schema)
        try:
            import json
            return json.loads(raw)
        except Exception:
            return {
                "colors": [],
                "fonts": [],
                "components": [],
                "layout": raw[:500],
                "brand_style": "",
            }

    # ------------------------------------------------------------------
    # Fallback
    # ------------------------------------------------------------------

    @staticmethod
    def _httpx_scrape(url: str) -> str:
        """Basic HTML fetch without firecrawl."""
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                resp = client.get(url, headers={"User-Agent": "pakalon/1.0"})
                resp.raise_for_status()
                text = resp.text
                # Very naive: strip HTML tags
                import re
                cleaned = re.sub(r"<[^>]+>", " ", text)
                cleaned = re.sub(r"\s+", " ", cleaned).strip()
                return cleaned[:8000]
        except Exception as e:
            return f"[Fetch error: {e}]"
