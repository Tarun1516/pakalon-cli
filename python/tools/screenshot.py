"""
screenshot.py — Screenshot and design analysis tool for Pakalon agents.
T098: ScreenshotTool with capture/analyze_design/compare using playwright + vision model.
"""
from __future__ import annotations

import base64
import os
import pathlib
import tempfile
from typing import Any

import httpx

try:
    from playwright.sync_api import sync_playwright  # type: ignore
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


VISION_MODEL = os.environ.get("PAKALON_VISION_MODEL", "google/gemini-flash-1.5")
OPENROUTER_BASE = "https://openrouter.ai/api/v1"


class ScreenshotTool:
    """
    Browser screenshot + vision-based design analysis.
    Uses Playwright for captures, OpenRouter vision model for analysis.
    """

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def capture(self, url: str, full_page: bool = True) -> str:
        """
        Capture a screenshot of the URL.
        Returns base64-encoded PNG string.
        """
        if not PLAYWRIGHT_AVAILABLE:
            return self._placeholder_png()

        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(headless=True)
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                page.goto(url, wait_until="networkidle", timeout=30000)
                png_bytes = page.screenshot(full_page=full_page)
                browser.close()
                return base64.b64encode(png_bytes).decode()
        except Exception as e:
            return f"[Screenshot error: {e}]"

    def capture_to_file(self, url: str, output_path: str | None = None) -> str:
        """Capture screenshot to file. Returns path."""
        b64 = self.capture(url)
        if b64.startswith("["):
            raise RuntimeError(b64)

        out_path = output_path or tempfile.mktemp(suffix=".png")
        png_bytes = base64.b64decode(b64)
        pathlib.Path(out_path).write_bytes(png_bytes)
        return out_path

    def analyze_design(self, url: str) -> dict[str, Any]:
        """
        Capture + analyze a URL for design tokens.
        Returns {colors, fonts, layout, components, brand_style}.
        """
        b64 = self.capture(url)
        if b64.startswith("["):
            return {"error": b64, "colors": [], "fonts": [], "components": [], "layout": ""}

        prompt = (
            "Analyze this website screenshot and extract: "
            "1) Primary/secondary/accent colors (hex codes), "
            "2) Font families visible, "
            "3) Key UI components (navbar, hero, cards, etc.), "
            "4) Overall layout structure (grid/flex/columns), "
            "5) Brand style description (minimal/bold/corporate/etc). "
            "Return JSON with keys: colors (array), fonts (array), "
            "components (array), layout (string), brand_style (string)."
        )
        raw = self._vision_query(b64, prompt)
        try:
            import json
            # Extract JSON from potential markdown wrapper
            import re
            match = re.search(r"\{.*\}", raw, re.DOTALL)
            if match:
                return json.loads(match.group())
        except Exception:
            pass
        return {
            "colors": [],
            "fonts": [],
            "components": [],
            "layout": raw[:500],
            "brand_style": "",
        }

    def compare(self, img1_path: str, img2_path: str) -> dict[str, Any]:
        """
        Compare two screenshots and return similarity score + diff regions.
        Returns {similarity: float, diff_regions: list, description: str}.
        """
        b64_1 = base64.b64encode(pathlib.Path(img1_path).read_bytes()).decode()
        b64_2 = base64.b64encode(pathlib.Path(img2_path).read_bytes()).decode()

        prompt = (
            "Compare these two website screenshots. "
            "Identify: 1) overall visual similarity (0-100), "
            "2) regions that differ (as text descriptions), "
            "3) missing elements from image 2 vs image 1. "
            "Return JSON: {similarity: number, diff_regions: [string], missing_elements: [string]}."
        )
        # Send both images as separate messages
        raw = self._vision_multi_query([b64_1, b64_2], prompt)
        try:
            import json, re
            match = re.search(r"\{.*\}", raw, re.DOTALL)
            if match:
                return json.loads(match.group())
        except Exception:
            pass
        return {"similarity": 0, "diff_regions": [raw[:200]], "missing_elements": []}

    # ------------------------------------------------------------------
    # Vision model calls
    # ------------------------------------------------------------------

    def _vision_query(self, b64_png: str, prompt: str) -> str:
        if not self._api_key:
            return "[No OPENROUTER_API_KEY set]"
        try:
            with httpx.Client(timeout=60) as client:
                resp = client.post(
                    f"{OPENROUTER_BASE}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": VISION_MODEL,
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64_png}"}},
                                    {"type": "text", "text": prompt},
                                ],
                            }
                        ],
                        "max_tokens": 1024,
                    },
                )
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]["content"]
        except Exception as e:
            return f"[Vision error: {e}]"

    def _vision_multi_query(self, b64_images: list[str], prompt: str) -> str:
        if not self._api_key:
            return "[No OPENROUTER_API_KEY set]"
        content: list[dict[str, Any]] = [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}
            for b64 in b64_images
        ]
        content.append({"type": "text", "text": prompt})
        try:
            with httpx.Client(timeout=60) as client:
                resp = client.post(
                    f"{OPENROUTER_BASE}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": VISION_MODEL,
                        "messages": [{"role": "user", "content": content}],
                        "max_tokens": 1024,
                    },
                )
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]["content"]
        except Exception as e:
            return f"[Vision multi error: {e}]"

    @staticmethod
    def _placeholder_png() -> str:
        """Return a 1x1 transparent PNG base64 (fallback)."""
        data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        return data
