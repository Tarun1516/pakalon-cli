"""
figma_import.py — Figma design file importer for Phase 1.
T102: FigmaImporter extracts design spec from Figma URL or local export file.
Enhanced with: component frames, spacing, images, wireframe generation.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import base64
from typing import Any
from dataclasses import dataclass

import httpx

FIGMA_API_BASE = "https://api.figma.com/v1"


@dataclass
class FigmaComponent:
    """Represents a Figma component with its properties."""
    name: str
    node_id: str
    x: float
    y: float
    width: float
    height: float
    type: str
    children: list["FigmaComponent"]


class FigmaImporter:
    """
    Import Figma design files and extract: colors, typography,
    component names, page names, frames, spacing.

    Auth priority (T-CLI-28):
    1. Personal Access Token via FIGMA_ACCESS_TOKEN env var or constructor
    2. OAuth2 token via FIGMA_OAUTH_TOKEN env var (Bearer header)
    3. OAuth2 refresh flow via FIGMA_CLIENT_ID + FIGMA_CLIENT_SECRET + FIGMA_REFRESH_TOKEN
    """

    OAUTH_TOKEN_URL = "https://www.figma.com/api/oauth/token"

    def __init__(self, access_token: str | None = None) -> None:
        self._pat = access_token or os.environ.get("FIGMA_ACCESS_TOKEN", "")
        self._oauth_token = os.environ.get("FIGMA_OAUTH_TOKEN", "")
        self._client_id = os.environ.get("FIGMA_CLIENT_ID", "")
        self._client_secret = os.environ.get("FIGMA_CLIENT_SECRET", "")
        self._refresh_token = os.environ.get("FIGMA_REFRESH_TOKEN", "")
        self._client = None

    def _get_auth_headers(self) -> dict[str, str]:
        """Return the best available authorization header."""
        if self._pat:
            return {"X-Figma-Token": self._pat}
        if self._oauth_token:
            return {"Authorization": f"Bearer {self._oauth_token}"}
        # Try OAuth2 refresh
        if self._client_id and self._client_secret and self._refresh_token:
            refreshed = self._refresh_oauth_token()
            if refreshed:
                return {"Authorization": f"Bearer {refreshed}"}
        return {}

    def _refresh_oauth_token(self) -> str | None:
        """Exchange refresh token for a new access token."""
        try:
            with httpx.Client(timeout=15) as client:
                resp = client.post(
                    self.OAUTH_TOKEN_URL,
                    data={
                        "client_id": self._client_id,
                        "client_secret": self._client_secret,
                        "refresh_token": self._refresh_token,
                        "grant_type": "refresh_token",
                    },
                )
                resp.raise_for_status()
                token = resp.json().get("access_token", "")
                if token:
                    self._oauth_token = token  # cache for session
                return token or None
        except Exception as e:
            return None

    # ------------------------------------------------------------------
    # Entry point
    # ------------------------------------------------------------------

    def analyze(self, figma_url_or_file: str) -> dict[str, Any] | None:
        """
        Analyze a Figma file from URL or local JSON export.
        Returns design spec dict or None if token missing / error.
        """
        if not figma_url_or_file:
            return None

        # Check if it's a local file
        path = pathlib.Path(figma_url_or_file)
        if path.exists() and path.suffix == ".json":
            try:
                data = json.loads(path.read_text())
                return self._extract_from_json(data)
            except Exception as e:
                return {"error": f"Failed to parse local Figma export: {e}"}

        # Extract file key from URL
        file_key = self._extract_file_key(figma_url_or_file)
        if not file_key:
            return {"error": f"Could not extract Figma file key from: {figma_url_or_file}"}

        auth_headers = self._get_auth_headers()
        if not auth_headers:
            # Return None gracefully — caller should skip Figma path
            return None

        return self._fetch_and_analyze(file_key)

    # ------------------------------------------------------------------
    # API fetching
    # ------------------------------------------------------------------

    def _fetch_and_analyze(self, file_key: str) -> dict[str, Any] | None:
        """Fetch Figma file via REST API and extract design spec.
        Also fetches frame images via fetch_file_images() for deep analysis.
        """
        headers = self._get_auth_headers()
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.get(
                    f"{FIGMA_API_BASE}/files/{file_key}",
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()
                result = self._extract_from_json(data)
                # T-CLI-28: Fetch rendered images for each frame for deep visual analysis
                if result and "frames" in result and result["frames"]:
                    frame_node_ids = [f["node_id"] for f in result["frames"] if f.get("node_id")]
                    if frame_node_ids:
                        images = self.fetch_file_images(file_key, node_ids=frame_node_ids[:10])
                        result["frame_images"] = images
                return result
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 403:
                return {"error": "Figma access forbidden — check FIGMA_ACCESS_TOKEN, FIGMA_OAUTH_TOKEN, or OAuth2 credentials"}
            return {"error": f"Figma API error: {e}"}
        except Exception as e:
            return {"error": f"Failed to fetch Figma file: {e}"}

    def fetch_file_images(self, file_key: str, node_ids: list[str] | None = None, format: str = "png", scale: float = 2.0) -> dict[str, str]:
        """Fetch images for specific nodes (components/frames)."""
        headers = self._get_auth_headers()
        if not headers:
            return {}

        try:
            with httpx.Client(timeout=60) as client:
                resp = client.get(
                    f"{FIGMA_API_BASE}/images/{file_key}",
                    params={
                        "ids": ",".join(node_ids) if node_ids else "",
                        "format": format,
                        "scale": scale,
                    },
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()
                return data.get("images", {})
        except Exception:
            return {}

    # ------------------------------------------------------------------
    # JSON parsing
    # ------------------------------------------------------------------

    def _extract_from_json(self, data: dict[str, Any]) -> dict[str, Any]:
        """Extract design tokens from a Figma file JSON."""
        result: dict[str, Any] = {
            "title": data.get("name", "Untitled"),
            "last_modified": data.get("lastModified", ""),
            "pages": [],
            "colors": [],
            "fonts": [],
            "components": [],
            "frames": [],
            "spacing": {"padding": [], "gaps": []},
            "text_styles": [],
        }

        # Pages
        document = data.get("document", {})
        children = document.get("children", [])
        result["pages"] = [page.get("name", f"Page {i+1}") for i, page in enumerate(children)]

        # Extract from styles
        styles = data.get("styles", {})
        for _style_id, style_data in styles.items():
            style_type = style_data.get("styleType", "")
            name = style_data.get("name", "")
            if style_type == "FILL" and name:
                result["colors"].append(name)
            elif style_type == "TEXT" and name:
                result["fonts"].append(name)

        # Extract from components
        components = data.get("components", {})
        result["components"] = [c.get("name", "") for c in components.values() if c.get("name")]

        # Walk document tree for additional colors/fonts/frames
        self._walk_node(document, result)

        # Extract frames (top-level frames on each page)
        for page in children:
            frames = page.get("children", [])
            for frame in frames:
                if frame.get("type") in ("FRAME", "COMPONENT", "COMPONENT_SET"):
                    result["frames"].append({
                        "name": frame.get("name", ""),
                        "node_id": frame.get("id", ""),
                        "width": frame.get("absoluteBoundingBox", {}).get("width", 0),
                        "height": frame.get("absoluteBoundingBox", {}).get("height", 0),
                    })

        # Deduplicate
        result["colors"] = list(dict.fromkeys(result["colors"]))[:20]
        result["fonts"] = list(dict.fromkeys(result["fonts"]))[:10]
        result["components"] = list(dict.fromkeys(result["components"]))[:30]
        result["frames"] = result["frames"][:20]

        return result

    @staticmethod
    def _walk_node(node: dict[str, Any], result: dict[str, Any]) -> None:
        """Recursively walk Figma node tree to extract design tokens."""
        node_type = node.get("type", "")

        # Colors from fills
        fills = node.get("fills", [])
        for fill in fills:
            if fill.get("type") == "SOLID":
                color = fill.get("color", {})
                r = int(color.get("r", 0) * 255)
                g = int(color.get("g", 0) * 255)
                b = int(color.get("b", 0) * 255)
                hex_color = f"#{r:02x}{g:02x}{b:02x}"
                if hex_color != "#000000":
                    result["colors"].append(hex_color)

        # Extract padding from explicit padding fields
        padding = node.get("paddingLeft", 0) or node.get("paddingRight", 0) or node.get("paddingTop", 0) or node.get("paddingBottom", 0)
        if padding:
            result["spacing"]["padding"].append(padding)

        # Extract item spacing from main component
        item_spacing = node.get("itemSpacing", 0)
        if item_spacing:
            result["spacing"]["gaps"].append(item_spacing)

        # Extract corner radius
        corner_radius = node.get("cornerRadius", 0)
        if corner_radius and node_type == "RECTANGLE":
            result["spacing"]["radius"] = corner_radius

        # Text styles
        style = node.get("style", {})
        if style:
            font_family = style.get("fontFamily", "")
            font_size = style.get("fontSize", 0)
            font_weight = style.get("fontWeight", 0)
            if font_family:
                result["text_styles"].append({
                    "family": font_family,
                    "size": font_size,
                    "weight": font_weight,
                })

        # Recurse
        for child in node.get("children", []):
            FigmaImporter._walk_node(child, result)

    @staticmethod
    def _extract_file_key(url: str) -> str | None:
        """Extract Figma file key from URL."""
        # https://www.figma.com/file/KEY/name
        match = re.search(r"figma\.com/(?:file|design)/([A-Za-z0-9]+)", url)
        if match:
            return match.group(1)
        # Raw key (no URL)
        if re.match(r"^[A-Za-z0-9]{20,}$", url):
            return url
        return None

    # ------------------------------------------------------------------
    # Enhanced extraction methods
    # ------------------------------------------------------------------

    def get_file_images(self, file_key: str, node_ids: list[str] | None = None) -> dict[str, Any] | None:
        """Get rendered images for nodes in a Figma file."""
        if not self._pat:
            return None
        try:
            params = {"ids": ",".join(node_ids)} if node_ids else None
            with httpx.Client(timeout=30) as client:
                resp = client.get(
                    f"{FIGMA_API_BASE}/images/{file_key}",
                    headers={"X-Figma-Token": self._pat},
                    params=params,
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            return {"error": f"Failed to get images: {e}"}

    def get_file_styles(self, file_key: str) -> dict[str, Any] | None:
        """Get all styles defined in a Figma file."""
        if not self._pat:
            return None
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.get(
                    f"{FIGMA_API_BASE}/files/{file_key}/styles",
                    headers={"X-Figma-Token": self._pat},
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            return {"error": f"Failed to get styles: {e}"}

    def get_file_components(self, file_key: str) -> dict[str, Any] | None:
        """Get all components in a Figma file with their properties."""
        if not self._pat:
            return None
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.get(
                    f"{FIGMA_API_BASE}/files/{file_key}/components",
                    headers={"X-Figma-Token": self._pat},
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            return {"error": f"Failed to get components: {e}"}

    def extract_frames(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        """Extract frames/canvases with layout information."""
        frames = []
        document = data.get("document", {})

        def walk_for_frames(node: dict[str, Any], page_name: str = ""):
            node_type = node.get("type", "")
            if node_type in ("FRAME", "COMPONENT", "COMPONENT_SET"):
                frame = {
                    "id": node.get("id", ""),
                    "name": node.get("name", ""),
                    "type": node_type,
                    "page": page_name,
                    "width": node.get("absoluteBoundingBox", {}).get("width", 0),
                    "height": node.get("absoluteBoundingBox", {}).get("height", 0),
                    "x": node.get("absoluteBoundingBox", {}).get("x", 0),
                    "y": node.get("absoluteBoundingBox", {}).get("y", 0),
                }

                # Layout properties
                layout_mode = node.get("layoutMode", "NONE")
                if layout_mode != "NONE":
                    frame["layout"] = {
                        "mode": layout_mode,
                        "gap": node.get("itemSpacing", 0),
                        "padding": node.get("paddingTop", 0),
                        "align": node.get("primaryAxisAlignItems", "MIN"),
                    }

                # Auto-layout constraints
                constraints = node.get("constraints", {})
                if constraints:
                    frame["constraints"] = {
                        "horizontal": constraints.get("horizontal", "LEFT"),
                        "vertical": constraints.get("vertical", "TOP"),
                    }

                frames.append(frame)

            # Recurse
            for child in node.get("children", []):
                walk_for_frames(child, page_name or node.get("name", ""))

        # Walk through all pages
        for page in document.get("children", []):
            page_name = page.get("name", "")
            for child in page.get("children", []):
                walk_for_frames(child, page_name)

        return frames

    def extract_wireframe_format(self, data: dict[str, Any]) -> dict[str, Any]:
        """Convert Figma design to wireframe format for code generation."""
        wireframe = {
            "title": data.get("name", "Untitled"),
            "pages": [],
            "components": [],
            "colors": [],
            "typography": [],
            "spacing": [],
            "layouts": [],
        }

        # Extract pages
        document = data.get("document", {})
        for page in document.get("children", []):
            page_data = {
                "name": page.get("name", ""),
                "frames": [],
            }

            # Extract frames from page
            for frame in page.get("children", []):
                frame_data = self._extract_frame_wireframe(frame)
                if frame_data:
                    page_data["frames"].append(frame_data)

            wireframe["pages"].append(page_data)

        # Extract colors
        wireframe["colors"] = self._extract_colors(data)

        # Extract typography
        wireframe["typography"] = self._extract_typography(data)

        return wireframe

    def _extract_frame_wireframe(self, node: dict[str, Any]) -> dict[str, Any] | None:
        """Extract a single frame in wireframe format."""
        node_type = node.get("type", "")
        if node_type not in ("FRAME", "COMPONENT", "COMPONENT_SET", "GROUP"):
            return None

        wireframe_frame = {
            "id": node.get("id", ""),
            "name": node.get("name", ""),
            "type": node_type,
            "width": node.get("absoluteBoundingBox", {}).get("width", 0),
            "height": node.get("absoluteBoundingBox", {}).get("height", 0),
            "elements": [],
        }

        # Extract child elements
        for child in node.get("children", []):
            element = self._extract_element_wireframe(child)
            if element:
                wireframe_frame["elements"].append(element)

        return wireframe_frame

    def _extract_element_wireframe(self, node: dict[str, Any]) -> dict[str, Any] | None:
        """Extract a single element in wireframe format."""
        node_type = node.get("type", "")
        element = {
            "type": node_type,
            "name": node.get("name", ""),
        }

        # Add geometry for shapes
        if node_type in ("RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR"):
            element["geometry"] = {
                "width": node.get("absoluteBoundingBox", {}).get("width", 0),
                "height": node.get("absoluteBoundingBox", {}).get("height", 0),
                "fills": node.get("fills", []),
            }

        # Add text properties
        if node_type == "TEXT":
            style = node.get("style", {})
            element["text"] = {
                "content": node.get("characters", ""),
                "fontFamily": style.get("fontFamily", "Inter"),
                "fontSize": style.get("fontSize", 14),
                "fontWeight": style.get("fontWeight", 400),
                "color": self._get_text_color(style),
            }

        # Add layout info
        layout_mode = node.get("layoutMode", "NONE")
        if layout_mode != "NONE":
            element["layout"] = {
                "type": layout_mode,
                "gap": node.get("itemSpacing", 0),
            }

        return element

    def _extract_colors(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        """Extract all colors from the design."""
        colors = []
        seen_colors = set()

        def walk_colors(node: dict[str, Any]):
            fills = node.get("fills", [])
            for fill in fills:
                if fill.get("type") == "SOLID":
                    color = fill.get("color", {})
                    r = int(color.get("r", 0) * 255)
                    g = int(color.get("g", 0) * 255)
                    b = int(color.get("b", 0) * 255)
                    a = color.get("a", 1)
                    hex_color = f"#{r:02x}{g:02x}{b:02x}"
                    if hex_color not in seen_colors:
                        seen_colors.add(hex_color)
                        colors.append({
                            "hex": hex_color,
                            "opacity": a,
                            "name": node.get("name", ""),
                        })

            for child in node.get("children", []):
                walk_colors(child)

        walk_colors(data.get("document", {}))
        return colors[:20]

    def _extract_typography(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        """Extract typography styles."""
        typography = []
        seen_styles = set()

        def walk_typography(node: dict[str, Any]):
            style = node.get("style", {})
            key = f"{style.get('fontFamily', '')}-{style.get('fontSize', 0)}"
            if key not in seen_styles and style.get("fontFamily"):
                seen_styles.add(key)
                typography.append({
                    "fontFamily": style.get("fontFamily", "Inter"),
                    "fontSize": style.get("fontSize", 14),
                    "fontWeight": style.get("fontWeight", 400),
                    "lineHeight": style.get("lineHeightPx", 0),
                    "letterSpacing": style.get("letterSpacing", 0),
                })

            for child in node.get("children", []):
                walk_typography(child)

        walk_typography(data.get("document", {}))
        return typography[:10]

    def _get_text_color(self, style: dict[str, Any]) -> str:
        """Get text color from style."""
        fills = style.get("fills", [])
        for fill in fills:
            if fill.get("type") == "SOLID":
                color = fill.get("color", {})
                r = int(color.get("r", 0) * 255)
                g = int(color.get("g", 0) * 255)
                b = int(color.get("b", 0) * 255)
                return f"#{r:02x}{g:02x}{b:02x}"
        return "#000000"

    def export_to_wireframe_json(self, figma_url: str, output_path: str) -> dict[str, Any]:
        """Fetch Figma file and export to wireframe JSON format."""
        result = self.analyze(figma_url)
        if not result or "error" in result:
            return result

        wireframe = self.extract_wireframe_format(result)
        output = pathlib.Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(wireframe, indent=2))
        return {"status": "ok", "path": str(output), "wireframe": wireframe}

    # ------------------------------------------------------------------
    # Wireframe generation
    # ------------------------------------------------------------------

    def generate_wireframe(self, figma_data: dict[str, Any], output_format: str = "html") -> str:
        """
        Generate a wireframe from Figma design data.
        Supports: html, json, svg
        """
        if output_format == "json":
            return self._generate_wireframe_json(figma_data)
        elif output_format == "svg":
            return self._generate_wireframe_svg(figma_data)
        else:
            return self._generate_wireframe_html(figma_data)

    def _generate_wireframe_json(self, data: dict[str, Any]) -> str:
        """Generate JSON wireframe representation."""
        wireframe = {
            "title": data.get("title", "Wireframe"),
            "frames": [],
            "colors": data.get("colors", [])[:5],
            "fonts": data.get("fonts", [])[:3],
        }

        for frame in data.get("frames", [])[:5]:
            wireframe["frames"].append({
                "name": frame.get("name", ""),
                "width": frame.get("width", 0),
                "height": frame.get("height", 0),
                "type": "frame",
            })

        return json.dumps(wireframe, indent=2)

    def _generate_wireframe_svg(self, data: dict[str, Any]) -> str:
        """Generate SVG wireframe representation."""
        svg_parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900">']
        svg_parts.append(f'<style>.frame{{fill:#f3f4f6;stroke:#d1d5db;stroke-width:2}} text{{font-family:system-ui}}</style>')
        svg_parts.append(f'<rect width="100%" height="100%" fill="white"/>')

        colors = data.get("colors", [])[:5]
        y_offset = 50
        for frame in data.get("frames", [])[:3]:
            width = min(frame.get("width", 400), 600)
            height = min(frame.get("height", 300), 400)
            svg_parts.append(f'<rect x="50" y="{y_offset}" width="{width}" height="{height}" class="frame" rx="8"/>')
            svg_parts.append(f'<text x="60" y="{y_offset + 30}" fill="#6b7280" font-size="14">{frame.get("name", "Frame")}</text>')
            # Add color indicator
            if colors:
                svg_parts.append(f'<rect x="{width - 30}" y="{y_offset + 10}" width="20" height="20" fill="{colors[0]}" rx="4"/>')
            y_offset += height + 80

        svg_parts.append('</svg>')
        return "\n".join(svg_parts)

    def _generate_wireframe_html(self, data: dict[str, Any]) -> str:
        """Generate HTML wireframe representation."""
        colors = data.get("colors", [])[:5]
        fonts = data.get("fonts", [])[:2]
        bg_color = colors[0] if colors else "#f3f4f6"

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{data.get("title", "Wireframe")} - Pakalon Wireframe</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: {fonts[0] if fonts else "system-ui"}, sans-serif; background: #fafafa; padding: 2rem; }}
  .container {{ max-width: 1200px; margin: 0 auto; }}
  h1 {{ color: #111; margin-bottom: 2rem; }}
  .frame {{ background: {bg_color}; border: 2px solid #e5e7eb; border-radius: 8px; padding: 1rem; margin-bottom: 2rem; }}
  .frame-name {{ color: #6b7280; font-size: 0.875rem; margin-bottom: 0.5rem; }}
  .frame-size {{ color: #9ca3af; font-size: 0.75rem; }}
  .color-palette {{ display: flex; gap: 0.5rem; margin-top: 1rem; }}
  .color-swatch {{ width: 40px; height: 40px; border-radius: 4px; border: 1px solid #e5e7eb; }}
  .placeholder {{ background: #e5e7eb; border-radius: 4px; height: 100px; margin: 0.5rem 0; }}
</style>
</head>
<body>
<div class="container">
<h1>{data.get("title", "Wireframe")}</h1>
"""
        for frame in data.get("frames", [])[:5]:
            html += f"""<div class="frame">
<div class="frame-name">{frame.get("name", "Frame")}</div>
<div class="frame-size">{frame.get("width", 0):.0f} x {frame.get("height", 0):.0f}px</div>
<div class="placeholder"></div>
</div>
"""

        if colors:
            html += '<div class="color-palette">'
            for color in colors:
                html += f'<div class="color-swatch" style="background:{color}" title="{color}"></div>'
            html += '</div>'

        html += "</div></body></html>"
        return html
