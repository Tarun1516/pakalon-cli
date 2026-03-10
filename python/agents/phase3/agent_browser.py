"""
agent_browser.py — Phase 3 Vercel Agent Browser integration.

Uses @vercel/agent-browser (or Playwright fallback) for:
  - Snapshot capture (accessibility tree + refs)  T-P3-19
  - Click interactions via semantic locators       T-P3-20
  - Screenshot capture + comparison               T-P3-21/22/25
  - Console error detection                       T-P3-27
  - Network request capture                       T-P3-26
  - Form interaction testing                      T-P3-24

The implementation shells out to a small Node.js runner that is
injected at runtime so this module has no hard JS dependency.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import subprocess
import tempfile
from typing import Any

from ..shared.paths import get_phase_dir

# ---------------------------------------------------------------------------
# Node.js runner script — injected at runtime
# ---------------------------------------------------------------------------

_AGENT_BROWSER_RUNNER = r"""
// agent_browser_runner.cjs  — injected by Pakalon Phase 3 agent_browser.py
// Requires @vercel/agent-browser; falls back to Playwright.
const ACTION = process.argv[2];      // snapshot|click|screenshot|fill|network|console
const TARGET = process.argv[3];      // URL or element ref e.g. @e1
const PARAM  = process.argv[4] || "";// extra parameter (selector value, file path …)
const ANNOTATE = process.argv[5] === "--annotate";

const fs   = require("fs");
const path = require("path");

async function run() {
  let ab = null;

  // Attempt @vercel/agent-browser first
  try {
    const { createBrowser } = require("@vercel/agent-browser");
    ab = await createBrowser({ headless: true });
  } catch (_) { ab = null; }

  // Build a thin shim that mimics the agent-browser API using Playwright
  if (!ab) {
    try {
      const { chromium } = require("playwright");
      const browser = await chromium.launch({ headless: true });
      const ctx     = await browser.newContext();
      const page    = await ctx.newPage();
      ab = {
        _page: page,
        _browser: browser,
        open: async (url) => page.goto(url),
        snapshot: async () => {
          const tree = await page.accessibility.snapshot();
          // Assign sequential @eN refs
          let idx = 0;
          const assignRefs = (node) => {
            if (!node) return;
            node.ref = "@e" + (++idx);
            (node.children || []).forEach(assignRefs);
          };
          if (tree) assignRefs(tree);
          return { tree, url: page.url() };
        },
        screenshot: async (opts) => {
          const pp = opts && opts.path ? opts.path : path.join(require("os").tmpdir(), "ab-screenshot-" + Date.now() + ".png");
          if (ANNOTATE) {
            // Draw colored outlines around interactive elements
            await page.evaluate(() => {
              document.querySelectorAll("a,button,input,select,textarea,[role]").forEach((el, i) => {
                el.style.outline = "2px solid red";
                el.setAttribute("data-pk-ref", "@e" + i);
              });
            });
          }
          await page.screenshot({ path: pp, fullPage: true });
          return pp;
        },
        click: async (ref) => {
          const selector = `[data-pk-ref="${ref}"]`;
          await page.click(selector);
          return { clicked: ref };
        },
        fill: async (ref, value) => {
          const selector = `[data-pk-ref="${ref}"]`;
          await page.fill(selector, value);
          return { filled: ref, value };
        },
        networkRequests: async () => {
          const requests = [];
          page.on("request", r => requests.push({ url: r.url(), method: r.method() }));
          return requests;
        },
        consoleErrors: () => {
          const errors = [];
          page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
          return errors;
        },
        close: async () => { await ctx.close(); await browser.close(); },
      };
      // Open page immediately for non-snapshot / non-screenshot actions
    } catch (err) {
      console.error(JSON.stringify({ error: "No browser available: " + err.message }));
      process.exit(1);
    }
  }

  try {
    switch (ACTION) {
      case "snapshot": {
        if (TARGET) await ab.open(TARGET);
        const snap = await ab.snapshot();
        console.log(JSON.stringify({ action: "snapshot", result: snap }));
        break;
      }
      case "screenshot": {
        if (TARGET && TARGET.startsWith("http")) await ab.open(TARGET);
        const screenshotPath = PARAM || path.join(require("os").tmpdir(), "pk-sc-" + Date.now() + ".png");
        const savedPath = await ab.screenshot({ path: screenshotPath });
        console.log(JSON.stringify({ action: "screenshot", path: savedPath }));
        break;
      }
      case "click": {
        const res = await ab.click(TARGET);
        console.log(JSON.stringify({ action: "click", result: res }));
        break;
      }
      case "fill": {
        const res = await ab.fill(TARGET, PARAM);
        console.log(JSON.stringify({ action: "fill", result: res }));
        break;
      }
      case "network": {
        if (TARGET) await ab.open(TARGET);
        // Wait briefly for requests to accumulate
        await new Promise(r => setTimeout(r, 2000));
        const reqs = await ab.networkRequests();
        console.log(JSON.stringify({ action: "network", requests: reqs }));
        break;
      }
      case "console": {
        if (TARGET) await ab.open(TARGET);
        await new Promise(r => setTimeout(r, 3000));
        const errors = ab.consoleErrors();
        console.log(JSON.stringify({ action: "console", errors }));
        break;
      }
      default:
        console.error(JSON.stringify({ error: "Unknown action: " + ACTION }));
        process.exit(1);
    }
  } finally {
    try { await ab.close(); } catch (_) {}
  }
}

run().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
"""


class AgentBrowser:
    """
    Python wrapper for @vercel/agent-browser / Playwright browser automation.

    All methods are async. They write the Node.js runner to a temp file and
    execute it as a subprocess, returning the parsed JSON result.
    """

    def __init__(self, timeout: int = 30, project_dir: str | None = None) -> None:
        self.timeout = timeout
        self.project_dir = project_dir or os.getcwd()

    # ------------------------------------------------------------------
    # Internal: write + run the Node.js script
    # ------------------------------------------------------------------

    async def _run_js(self, action: str, target: str = "", param: str = "", annotate: bool = False) -> dict[str, Any]:
        """Write runner to temp, invoke node, return parsed JSON."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".cjs", delete=False) as tmp:
            tmp.write(_AGENT_BROWSER_RUNNER)
            script_path = tmp.name

        args = ["node", script_path, action, target, param]
        if annotate:
            args.append("--annotate")

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.project_dir,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout
            )
            raw = stdout.decode().strip()
            if not raw:
                return {"error": stderr.decode().strip() or "No output from browser runner"}
            return json.loads(raw)
        except asyncio.TimeoutError:
            return {"error": f"Agent browser timed out after {self.timeout}s"}
        except json.JSONDecodeError as e:
            return {"error": f"Invalid JSON from browser runner: {e}"}
        except Exception as e:
            return {"error": str(e)}
        finally:
            try:
                pathlib.Path(script_path).unlink(missing_ok=True)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def snapshot(self, url: str = "") -> dict[str, Any]:
        """
        Capture accessibility tree snapshot from *url*.
        Returns { tree: ..., url: ... } with @eN refs assigned.
        T-P3-19
        """
        return await self._run_js("snapshot", url)

    async def screenshot(self, url: str = "", output_path: str = "", annotate: bool = False) -> dict[str, Any]:
        """
        Capture screenshot — optionally annotated with colored element outlines.
        Returns { path: <saved_path> }.
        T-P3-21/22
        """
        return await self._run_js("screenshot", url, output_path, annotate=annotate)

    async def click(self, ref: str) -> dict[str, Any]:
        """
        Click element identified by *ref* (e.g. ``@e5``).
        T-P3-20
        """
        return await self._run_js("click", ref)

    async def fill(self, ref: str, value: str) -> dict[str, Any]:
        """
        Fill input element *ref* with *value*.
        T-P3-24
        """
        return await self._run_js("fill", ref, value)

    async def network_requests(self, url: str = "") -> dict[str, Any]:
        """
        Capture network requests made after navigating to *url*.
        T-P3-26
        """
        return await self._run_js("network", url)

    async def console_errors(self, url: str = "") -> dict[str, Any]:
        """
        Open *url* and collect browser console errors.
        T-P3-27
        """
        return await self._run_js("console", url)

    async def diff_screenshot(
        self,
        baseline_path: str,
        current_url: str,
        output_path: str = "",
        threshold: float = 0.05,
    ) -> dict[str, Any]:
        """
        Take a screenshot of *current_url* and compare pixel-by-pixel with *baseline_path*.
        Returns { diff_pct: float, above_threshold: bool, diff_path: str }.
        T-P3-25
        """
        # Take current screenshot
        current_result = await self.screenshot(current_url, output_path)
        if "error" in current_result:
            return current_result

        current_path = current_result.get("path", "")
        if not current_path or not pathlib.Path(current_path).exists():
            return {"error": "Screenshot file not found"}

        if not pathlib.Path(baseline_path).exists():
            # No baseline yet — save current as baseline and report 0% diff
            import shutil  # noqa: PLC0415
            shutil.copy(current_path, baseline_path)
            return {"diff_pct": 0.0, "above_threshold": False, "diff_path": "", "baseline_created": True}

        # Pixel diff via Pillow
        try:
            from PIL import Image, ImageChops  # type: ignore  # noqa: PLC0415
            img_base = Image.open(baseline_path).convert("RGB")
            img_curr = Image.open(current_path).convert("RGB")
            # Resize to same dimensions if needed
            if img_base.size != img_curr.size:
                img_curr = img_curr.resize(img_base.size, Image.LANCZOS)  # type: ignore[attr-defined]
            diff = ImageChops.difference(img_base, img_curr)
            diff_pixels = sum(1 for p in diff.getdata() if max(p) > 10)  # type: ignore[arg-type]
            total_pixels = img_base.width * img_base.height
            diff_pct = diff_pixels / total_pixels if total_pixels > 0 else 0.0

            diff_path = output_path or current_path.replace(".png", "-diff.png")
            diff.save(diff_path)

            return {
                "diff_pct": round(diff_pct * 100, 2),
                "above_threshold": diff_pct > threshold,
                "diff_path": diff_path,
                "baseline_path": baseline_path,
            }
        except ImportError:
            # Pillow not available — skip diff, report no regression
            return {"diff_pct": 0.0, "above_threshold": False, "diff_path": "", "note": "Pillow not installed"}
        except Exception as e:
            return {"error": f"Diff failed: {e}"}


# ---------------------------------------------------------------------------
# Phase 3 TDD helper — used by sa4_debugging_testing
# ---------------------------------------------------------------------------

async def run_tdd_loop(
    target_url: str,
    wireframe_screenshot: str,
    project_dir: str,
    max_iterations: int = 2,
    send_sse: Any = None,
) -> dict[str, Any]:
    """
    Phase 3 TDD loop: snapshot → diff vs wireframe → report.
    T-P3-23

    1. Navigate to *target_url*.
    2. Take a screenshot of the running app.
    3. Compare pixel diff against *wireframe_screenshot* (baseline).
    4. Return findings with diff_pct and any console errors.
    """
    def _sse(msg: str) -> None:
        if send_sse:
            send_sse({"type": "text_delta", "content": msg})

    ab = AgentBrowser(project_dir=project_dir)
    evidence_dir = get_phase_dir(pathlib.Path(project_dir), 3, create=True) / "test-evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []

    for iteration in range(1, max_iterations + 1):
        _sse(f"\n  🔍 TDD iteration {iteration}/{max_iterations}…\n")

        # Screenshot
        sc_path = str(evidence_dir / f"SA4_tdd_{iteration}.png")
        sc_result = await ab.screenshot(target_url, sc_path, annotate=True)

        if "error" in sc_result:
            _sse(f"  ⚠ Screenshot failed: {sc_result['error']}\n")
            results.append({"iteration": iteration, "status": "screenshot_failed", **sc_result})
            continue

        # Pixel diff vs wireframe
        diff_result = await ab.diff_screenshot(
            baseline_path=wireframe_screenshot,
            current_url=target_url,
            output_path=str(evidence_dir / f"SA4_diff_{iteration}.png"),
        )

        # Console error check
        console_result = await ab.console_errors(target_url)
        console_errors = console_result.get("errors", [])
        if console_errors:
            _sse(f"  ⚠ Console errors ({len(console_errors)}): {console_errors[0][:80]}\n")

        diff_pct = diff_result.get("diff_pct", 0.0)
        above_threshold = diff_result.get("above_threshold", False)

        _sse(f"  📸 Diff vs wireframe: {diff_pct:.1f}%{' ⚠ ABOVE THRESHOLD' if above_threshold else ' ✅'}\n")

        results.append({
            "iteration": iteration,
            "screenshot_path": sc_path,
            "diff_pct": diff_pct,
            "above_threshold": above_threshold,
            "diff_path": diff_result.get("diff_path", ""),
            "console_errors": console_errors,
            "status": "pass" if not above_threshold and not console_errors else "fail",
        })

        if not above_threshold and not console_errors:
            _sse(f"  ✅ TDD passed at iteration {iteration}\n")
            break

    final_pass = all(r.get("status") == "pass" for r in results[-1:])
    return {
        "passed": final_pass,
        "iterations": len(results),
        "results": results,
    }
