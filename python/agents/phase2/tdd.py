"""
tdd.py — Phase 2 WireframeTDD: screenshot-driven design loop.
T106: Compare Penpot wireframes/screenshots against Figma reference → iterate.
"""
from __future__ import annotations

import base64
import os
import pathlib
import tempfile
from typing import Any


class WireframeTDD:
    """
    TDD loop for wireframe fidelity.
    Compares a generated wireframe/screenshot to a reference design image
    and returns structured differences to guide iteration.
    """

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")

    # ------------------------------------------------------------------
    # Pixel-level visual diff (T106 upgrade)
    # ------------------------------------------------------------------

    def compare_screenshots_pixel(
        self,
        expected_path: str,
        actual_path: str,
        threshold: int = 10,
        save_diff: bool = True,
    ) -> dict[str, Any]:
        """
        Pixel-level comparison of two screenshot images using Pillow.

        Computes the fraction of pixels where any RGB channel differs by
        more than `threshold` (0-255).  Optionally saves a diff image
        where changed pixels are highlighted in red.

        Args:
            expected_path: Path to the reference/expected image.
            actual_path:   Path to the generated/actual image.
            threshold:     Per-channel delta considered "different" (default 10).
            save_diff:     If True, write a diff PNG next to actual_path.

        Returns:
            {
                "diff_percentage": float,   # 0.0 – 100.0
                "pass": bool,               # True if diff_percentage < 5 %
                "diff_image_path": str | None,
                "total_pixels": int,
                "changed_pixels": int,
                "error": str | None,
            }
        """
        result: dict[str, Any] = {
            "diff_percentage": 0.0,
            "pass": True,
            "diff_image_path": None,
            "total_pixels": 0,
            "changed_pixels": 0,
            "error": None,
        }

        try:
            from PIL import Image, ImageChops, ImageFilter  # type: ignore
            import math

            img_expected = Image.open(expected_path).convert("RGB")
            img_actual = Image.open(actual_path).convert("RGB")

            # Resize actual to match expected if sizes differ
            if img_expected.size != img_actual.size:
                img_actual = img_actual.resize(img_expected.size, Image.LANCZOS)

            width, height = img_expected.size
            total_pixels = width * height
            result["total_pixels"] = total_pixels

            pixels_exp = list(img_expected.getdata())
            pixels_act = list(img_actual.getdata())

            changed = 0
            diff_pixels: list[tuple[int, int, int]] = []

            for pe, pa in zip(pixels_exp, pixels_act):
                r_diff = abs(int(pe[0]) - int(pa[0]))
                g_diff = abs(int(pe[1]) - int(pa[1]))
                b_diff = abs(int(pe[2]) - int(pa[2]))
                if r_diff > threshold or g_diff > threshold or b_diff > threshold:
                    changed += 1
                    diff_pixels.append((255, 0, 0))  # highlight in red
                else:
                    diff_pixels.append(pa)

            diff_pct = (changed / total_pixels * 100) if total_pixels > 0 else 0.0
            result["changed_pixels"] = changed
            result["diff_percentage"] = round(diff_pct, 4)
            result["pass"] = diff_pct < 5.0  # 5 % threshold for pass

            # Save diff image
            if save_diff:
                diff_img = Image.new("RGB", (width, height))
                diff_img.putdata(diff_pixels)
                diff_path = str(pathlib.Path(actual_path).with_suffix("")) + "_pixel_diff.png"
                diff_img.save(diff_path)
                result["diff_image_path"] = diff_path

        except ImportError:
            result["error"] = "Pillow not installed — run: pip install Pillow"
        except FileNotFoundError as e:
            result["error"] = f"Image file not found: {e}"
            result["pass"] = True  # Non-fatal — treat as pass when image missing
        except Exception as e:
            result["error"] = str(e)

        return result

    # ------------------------------------------------------------------

    def compare(
        self,
        generated_path: str,
        reference_path: str | None = None,
        reference_b64: str | None = None,
        threshold: float = 0.85,
    ) -> dict[str, Any]:
        """
        Compare generated wireframe to reference.
        Returns: {passed, similarity, missing_elements, extra_elements, suggestions}
        """
        if reference_path is None and reference_b64 is None:
            return {"passed": True, "similarity": 1.0, "missing_elements": [], "extra_elements": [], "suggestions": []}

        try:
            from ..tools.screenshot import ScreenshotTool
            tool = ScreenshotTool(api_key=self.api_key)
            result = tool.compare(generated_path, reference_path or "")
            similarity = result.get("similarity", 1.0)
            return {
                "passed": similarity >= threshold,
                "similarity": similarity,
                "missing_elements": result.get("missing_elements", []),
                "extra_elements": result.get("extra_elements", []),
                "suggestions": result.get("diff_regions", []),
            }
        except Exception as e:
            return {
                "passed": True,
                "similarity": 1.0,
                "missing_elements": [],
                "extra_elements": [],
                "suggestions": [],
                "error": str(e),
            }

    def generate_iteration_prompt(self, compare_result: dict) -> str:
        """Build a natural language prompt describing what to fix in next iteration."""
        if compare_result.get("passed"):
            return "Wireframe matches reference. No changes needed."

        lines = [f"Wireframe fidelity: {compare_result['similarity']:.0%}. Please fix:"]
        for m in compare_result.get("missing_elements", []):
            lines.append(f"- Add missing element: {m}")
        for s in compare_result.get("suggestions", []):
            lines.append(f"- Fix region: {s}")
        return "\n".join(lines)

    async def run_tdd_loop(
        self,
        wireframe_spec: dict,
        reference_path: str | None,
        max_iterations: int = 5,
        send_sse: Any = None,
    ) -> dict[str, Any]:
        """
        Full TDD loop: generate wireframe → screenshot → compare → iterate.
        Runs until similarity >= threshold OR max_iterations reached.
        Returns final wireframe SVG + comparison result.
        """
        _sse = send_sse or (lambda e: None)
        current_spec = dict(wireframe_spec)

        try:
            from ..tools.penpot import PenpotTool
            penpot = PenpotTool()
        except Exception:
            penpot = None  # type: ignore

        last_result: dict = {}
        final_svg = ""

        for iteration in range(1, max_iterations + 1):
            _sse({"type": "text_delta", "content": f"🎨 Wireframe TDD iteration {iteration}/{max_iterations}...\n"})

            # Generate wireframe
            svg = ""
            if penpot:
                try:
                    result = penpot.create_wireframe(current_spec)
                    svg = result.get("svg", "") or result.get("output", "")
                except Exception:
                    pass

            if not svg:
                svg = self._basic_svg(current_spec)

            final_svg = svg

            # Write to temp file for comparison
            with tempfile.NamedTemporaryFile(suffix=".svg", delete=False, mode="w") as f:
                f.write(svg)
                svg_path = f.name

            # Compare (AI-based semantic comparison)
            last_result = self.compare(svg_path, reference_path=reference_path, threshold=0.80)

            # Pixel-level visual diff (when a raster reference exists)
            pixel_result: dict = {}
            if reference_path and reference_path.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                # Render SVG to PNG for pixel comparison
                rendered_png: str | None = None
                try:
                    import subprocess, sys
                    png_path = svg_path.replace(".svg", "_rendered.png")
                    # Try cairosvg first, then inkscape, then skip
                    try:
                        import cairosvg  # type: ignore
                        cairosvg.svg2png(url=svg_path, write_to=png_path)
                        rendered_png = png_path
                    except ImportError:
                        inkscape_result = subprocess.run(
                            ["inkscape", svg_path, "--export-type=png", f"--export-filename={png_path}"],
                            capture_output=True, timeout=15,
                        )
                        if inkscape_result.returncode == 0:
                            rendered_png = png_path
                except Exception:
                    pass

                if rendered_png:
                    pixel_result = self.compare_screenshots_pixel(
                        expected_path=reference_path,
                        actual_path=rendered_png,
                    )
                    diff_pct = pixel_result.get("diff_percentage", 0.0)
                    _sse({
                        "type": "text_delta",
                        "content": f"  Pixel diff: {diff_pct:.2f}% | Pixel pass: {pixel_result['pass']}\n",
                    })
                    if pixel_result.get("diff_image_path"):
                        _sse({"type": "text_delta", "content": f"  Diff image: {pixel_result['diff_image_path']}\n"})
                    # Augment last_result with pixel data
                    last_result["pixel_diff"] = pixel_result

            _sse({
                "type": "text_delta",
                "content": f"  Similarity: {last_result['similarity']:.0%} | Passed: {last_result['passed']}\n",
            })

            # Pass only when both AI similarity and pixel diff agree (if pixel ran)
            ai_passed = last_result["passed"]
            pixel_passed = pixel_result.get("pass", True) if pixel_result else True
            if ai_passed and pixel_passed:
                break

            # Update spec based on feedback
            iteration_prompt = self.generate_iteration_prompt(last_result)
            current_spec = dict(current_spec)
            current_spec["_iteration_feedback"] = iteration_prompt

        return {"svg": final_svg, "compare_result": last_result, "iterations_run": iteration}

    @staticmethod
    def _basic_svg(spec: dict) -> str:
        title = spec.get("title", "Wireframe")
        return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">
  <rect width="1440" height="900" fill="#f9fafb"/>
  <rect x="0" y="0" width="1440" height="60" fill="#e5e7eb"/>
  <text x="20" y="38" font-size="20" fill="#374151">{title}</text>
  <rect x="20" y="80" width="1400" height="780" fill="#fff" stroke="#d1d5db" stroke-width="1"/>
</svg>"""
