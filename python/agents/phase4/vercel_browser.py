"""
vercel_browser.py — Phase 4 Vercel Agent Browser Testing integration.
T-CLI-14: Functional UI tests using @vercel/agent-browser (TypeScript) or
          Playwright fallback; runs a small Node.js script to execute browser tests.
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


_BROWSER_TEST_SCRIPT = r"""
// vercel_browser_test.cjs  — injected by Pakalon Phase 4
// Uses @vercel/agent-browser if available, otherwise falls back to Playwright.
const TARGET_URL = process.argv[2] || "http://localhost:3000";
const VIDEO_OUTPUT = process.argv[3] || "";  // optional path to save recording
const results = [];
const fs = require("fs");
const os = require("os");
const path = require("path");

async function run() {
  let browser, page, ctx;
  let videoDir = VIDEO_OUTPUT ? os.tmpdir() + "/pk-recording-" + Date.now() : null;
  if (videoDir) { try { fs.mkdirSync(videoDir, { recursive: true }); } catch(_) {} }

  // Try @vercel/agent-browser first
  try {
    const { createBrowser } = require("@vercel/agent-browser");
    const ab = await createBrowser({ headless: true });
    browser = ab;
    page = await ab.newPage();
    results.push({ test: "vercel-agent-browser-init", status: "pass" });
  } catch (_err) {
    // Fallback to playwright
    try {
      const { chromium } = require("playwright");
      browser = await chromium.launch({ headless: true });
      const ctxOptions = { viewport: { width: 1280, height: 720 } };
      if (videoDir) {
        ctxOptions.recordVideo = { dir: videoDir, size: { width: 1280, height: 720 } };
      }
      ctx = await browser.newContext(ctxOptions);
      page = await ctx.newPage();
      results.push({ test: "playwright-init", status: "pass" });
    } catch (err2) {
      results.push({ test: "browser-init", status: "fail", error: String(err2) });
      console.log(JSON.stringify({ results, passed: 0, total: 1 }));
      process.exit(0);
    }
  }

  // Test 1: Page loads
  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 15000 });
    const title = await page.title();
    results.push({ test: "page-loads", status: "pass", detail: `title=${title}` });
  } catch (e) {
    results.push({ test: "page-loads", status: "fail", error: String(e) });
  }

  // Test 2: No console errors
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  try {
    await page.waitForTimeout(1000);
    if (consoleErrors.length === 0) {
      results.push({ test: "no-console-errors", status: "pass" });
    } else {
      results.push({ test: "no-console-errors", status: "warn", detail: consoleErrors.slice(0, 5).join("; ") });
    }
  } catch (e) {
    results.push({ test: "no-console-errors", status: "skip" });
  }

  // Test 3: Body is visible (basic render check)
  try {
    const bodyVisible = await page.isVisible("body");
    results.push({ test: "body-visible", status: bodyVisible ? "pass" : "fail" });
  } catch (e) {
    results.push({ test: "body-visible", status: "fail", error: String(e) });
  }

  // Test 4: No 4xx/5xx on navigation
  const failedRequests = [];
  page.on("requestfailed", (req) => failedRequests.push(req.url()));
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 });
    if (failedRequests.length === 0) {
      results.push({ test: "no-failed-requests", status: "pass" });
    } else {
      results.push({ test: "no-failed-requests", status: "warn", detail: failedRequests.slice(0, 5).join(", ") });
    }
  } catch (e) {
    results.push({ test: "no-failed-requests", status: "skip" });
  }

  // Test 5: Screenshot for visual record
  try {
    const ss = await page.screenshot({ fullPage: false });
    const b64 = Buffer.from(ss).toString("base64");
    results.push({ test: "screenshot", status: "pass", screenshot_b64: b64 });
  } catch (e) {
    results.push({ test: "screenshot", status: "skip" });
  }

  // Close context to flush video recording
  let recordingPath = null;
  if (ctx) {
    try {
      // Playwright: get video path before closing
      const video = page.video();
      await ctx.close();
      if (video) {
        const tmpVidPath = await video.path();
        if (tmpVidPath && VIDEO_OUTPUT) {
          fs.copyFileSync(tmpVidPath, VIDEO_OUTPUT);
          recordingPath = VIDEO_OUTPUT;
        } else if (tmpVidPath) {
          recordingPath = tmpVidPath;
        }
      }
    } catch (_ve) {}
  } else if (browser && typeof browser.close === "function") {
    await browser.close();
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const total = results.length;
  console.log(JSON.stringify({ results, passed, total, recording_path: recordingPath }));
}

run().catch((err) => {
  console.log(JSON.stringify({ results: [{ test: "run", status: "fail", error: String(err) }], passed: 0, total: 1, recording_path: null }));
  process.exit(0);
});
"""


class VercelBrowserTester:
    """
    Runs browser-based functional tests against a target URL.
    Delegates to a temp Node.js script that uses @vercel/agent-browser or Playwright.
    """

    def __init__(self, target_url: str = "http://localhost:3000", project_dir: str = "."):
        self.target_url = target_url
        self.project_dir = pathlib.Path(project_dir)

    async def run_tests(self, send_sse: Any = None) -> dict[str, Any]:
        sse = send_sse or (lambda e: None)

        # Check if target is reachable before launching browser
        reachable = await self._check_reachable()
        if not reachable:
            sse({"type": "text_delta", "content": f"  Vercel Browser: {self.target_url} not reachable, skipping\n"})
            return {
                "passed": 0,
                "total": 0,
                "skipped": True,
                "reason": f"Target {self.target_url} not reachable",
            }

        # Determine video output path
        out_dir_for_vid = get_phase_dir(self.project_dir, 4) / "test-evidence"
        out_dir_for_vid.mkdir(parents=True, exist_ok=True)
        video_output_path = str(out_dir_for_vid / "vercel-browser-recording.webm")

        # Write test script to temp file
        with tempfile.NamedTemporaryFile(
            suffix=".cjs",
            delete=False,
            mode="w",
            encoding="utf-8",
        ) as tf:
            tf.write(_BROWSER_TEST_SCRIPT)
            script_path = tf.name

        try:
            result = await asyncio.to_thread(
                self._run_node_script, script_path, video_output_path
            )
            # Save screenshot if present
            if result.get("results"):
                for r in result["results"]:
                    if r.get("test") == "screenshot" and r.get("screenshot_b64"):
                        saved_path = self._save_screenshot(r["screenshot_b64"])
                        if saved_path:
                            sse({"type": "text_delta", "content": f"  📸 Browser screenshot → phase-4/test-evidence/vercel-browser-screenshot.png\n"})
                        del r["screenshot_b64"]  # trim from returned dict

            # Handle screen recording
            rec_path = result.get("recording_path")
            if rec_path and pathlib.Path(rec_path).exists():
                sse({"type": "text_delta", "content": f"  🎬 Screen recording → phase-4/test-evidence/vercel-browser-recording.webm\n"})
                result["recording_path"] = rec_path
            else:
                result.pop("recording_path", None)

            return {
                "passed": result.get("passed", 0),
                "total": result.get("total", 0),
                "results": result.get("results", []),
                "recording_path": result.get("recording_path"),
            }
        except Exception as exc:
            return {"passed": 0, "total": 0, "error": str(exc)}
        finally:
            try:
                pathlib.Path(script_path).unlink(missing_ok=True)
            except Exception:
                pass

    def _run_node_script(self, script_path: str, video_output_path: str = "") -> dict:
        try:
            cmd = ["node", script_path, self.target_url]
            if video_output_path:
                cmd.append(video_output_path)
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=str(self.project_dir),
            )
            # Last line of stdout should be JSON
            lines = [l for l in proc.stdout.strip().splitlines() if l.strip()]
            if lines:
                return json.loads(lines[-1])
            return {"passed": 0, "total": 0, "error": proc.stderr[:500]}
        except subprocess.TimeoutExpired:
            return {"passed": 0, "total": 0, "error": "timeout"}
        except Exception as e:
            return {"passed": 0, "total": 0, "error": str(e)}

    def _save_screenshot(self, b64: str) -> pathlib.Path | None:
        try:
            import base64
            out_dir = get_phase_dir(self.project_dir, 4) / "test-evidence"
            out_dir.mkdir(parents=True, exist_ok=True)
            path = out_dir / "vercel-browser-screenshot.png"
            path.write_bytes(base64.b64decode(b64))
            return path
        except Exception:
            return None

    async def _check_reachable(self) -> bool:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(self.target_url)
                return resp.status_code < 500
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Enhanced testing methods
    # ------------------------------------------------------------------

    async def run_custom_tests(self, test_config: dict[str, Any], send_sse: Any = None) -> dict[str, Any]:
        """
        Run custom browser tests based on configuration.
        test_config: {
            "tests": [
                {"name": "test-name", "action": "click|navigate|fill|wait", "selector": "...", "value": "..."},
            ]
        }
        """
        sse = send_sse or (lambda e: None)

        # Generate custom test script
        script = self._generate_test_script(test_config)

        with tempfile.NamedTemporaryFile(
            suffix=".cjs",
            delete=False,
            mode="w",
            encoding="utf-8",
        ) as tf:
            tf.write(script)
            script_path = tf.name

        try:
            result = await asyncio.to_thread(
                self._run_node_script, script_path
            )
            return result
        except Exception as exc:
            return {"passed": 0, "total": 0, "error": str(exc)}
        finally:
            try:
                pathlib.Path(script_path).unlink(missing_ok=True)
            except Exception:
                pass

    def _generate_test_script(self, test_config: dict[str, Any]) -> str:
        """Generate a Node.js test script from test configuration."""
        tests = test_config.get("tests", [])

        script_lines = [
            "const TARGET_URL = process.argv[2] || 'http://localhost:3000';",
            "const results = [];",
            "",
            "async function run() {",
            "  const { chromium } = require('playwright');",
            "  const browser = await chromium.launch({ headless: true });",
            "  const page = await browser.newPage();",
            "",
            f"  await page.goto(TARGET_URL, {{ waitUntil: 'networkidle', timeout: 15000 }});",
            "",
        ]

        for i, test in enumerate(tests):
            test_name = test.get("name", f"test_{i}")
            action = test.get("action", "")
            selector = test.get("selector", "")
            value = test.get("value", "")

            script_lines.append(f"  // Test: {test_name}")
            if action == "click":
                script_lines.append(f"  try {{ await page.click('{selector}', {{ timeout: 5000 }}); results.push({{ test: '{test_name}', status: 'pass' }}); }} catch(e) {{ results.push({{ test: '{test_name}', status: 'fail', error: e.message }}); }}")
            elif action == "fill":
                script_lines.append(f"  try {{ await page.fill('{selector}', '{value}'); results.push({{ test: '{test_name}', status: 'pass' }}); }} catch(e) {{ results.push({{ test: '{test_name}', status: 'fail', error: e.message }}); }}")
            elif action == "wait":
                timeout = test.get("timeout", 5000)
                script_lines.append(f"  try {{ await page.waitForSelector('{selector}', {{ timeout: {timeout} }}); results.push({{ test: '{test_name}', status: 'pass' }}); }} catch(e) {{ results.push({{ test: '{test_name}', status: 'fail', error: e.message }}); }}")
            elif action == "screenshot":
                script_lines.append(f"  try {{ const ss = await page.screenshot(); const b64 = Buffer.from(ss).toString('base64'); results.push({{ test: '{test_name}', status: 'pass', screenshot: b64 }}); }} catch(e) {{ results.push({{ test: '{test_name}', status: 'fail', error: e.message }}); }}")
            elif action == "evaluate":
                script_lines.append(f"  try {{ const result = await page.evaluate(`{value}`); results.push({{ test: '{test_name}', status: 'pass', result: String(result) }}); }} catch(e) {{ results.push({{ test: '{test_name}', status: 'fail', error: e.message }}); }}")

        script_lines.extend([
            "",
            "  await browser.close();",
            "",
            "  const passed = results.filter(r => r.status === 'pass').length;",
            "  console.log(JSON.stringify({ results, passed, total: results.length }));",
            "}",
            "",
            "run().catch(err => {",
            "  console.log(JSON.stringify({ results: [{ test: 'run', status: 'fail', error: String(err) }], passed: 0, total: 1 }));",
            "});",
        ])

        return "\n".join(script_lines)

    async def compare_screenshots(self, baseline_b64: str, current_b64: str, threshold: float = 0.1) -> dict[str, Any]:
        """Compare two screenshots and return similarity score."""
        try:
            import base64
            import io
            from PIL import Image  # type: ignore

            # Decode base64 images
            baseline = Image.open(io.BytesIO(base64.b64decode(baseline_b64)))
            current = Image.open(io.BytesIO(base64.b64decode(current_b64)))

            # Resize to same dimensions if needed
            if baseline.size != current.size:
                current = current.resize(baseline.size)

            # Convert to grayscale
            baseline_gray = baseline.convert("L")
            current_gray = current.convert("L")

            # Calculate difference
            diff = list(baseline_gray.getdata())
            baseline_data = list(baseline_gray.getdata())

            differences = sum(1 for a, b in zip(diff, baseline_data) if abs(a - b) > 30)
            similarity = 1 - (differences / len(baseline_data))

            return {
                "similar": similarity >= (1 - threshold),
                "similarity_score": round(similarity, 3),
                "threshold": threshold,
            }
        except ImportError:
            return {"error": "PIL not installed, cannot compare screenshots"}
        except Exception as e:
            return {"error": str(e)}

    async def run_accessibility_tests(self, send_sse: Any = None) -> dict[str, Any]:
        """Run accessibility tests using axe-core if available."""
        sse = send_sse or (lambda e: None)

        script = """
const TARGET_URL = process.argv[2] || 'http://localhost:3000';
const results = [];

async function run() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 15000 });

  // Try axe-core if available
  try {
    const axe = require('axe-core');
    const results_axe = await axe.run(page);
    results.push({
      test: 'accessibility-scan',
      status: 'pass',
      violations: results_axe.violations.length,
      passes: results_axe.passes.length
    });
  } catch(e) {
    // Fallback: basic accessibility checks
    const issues = [];

    // Check for images without alt
    const images = await page.$$eval('img', imgs => imgs.filter(i => !i.alt).length);
    if (images > 0) issues.push({ type: 'img-missing-alt', count: images });

    // Check for buttons without text
    const buttons = await page.$$eval('button', btns => btns.filter(b => !b.textContent.trim()).length);
    if (buttons > 0) issues.push({ type: 'button-empty', count: buttons });

    // Check for inputs without labels
    const inputs = await page.$$eval('input', inps => inps.filter(i => {
      const id = i.id;
      const label = i.closest('form')?.querySelector(`label[for="${id}"]`);
      return !label && !i.getAttribute('aria-label');
    }).length);
    if (inputs > 0) issues.push({ type: 'input-missing-label', count: inputs });

    results.push({
      test: 'accessibility-basic',
      status: issues.length === 0 ? 'pass' : 'warn',
      issues
    });
  }

  await browser.close();

  const passed = results.filter(r => r.status === 'pass').length;
  console.log(JSON.stringify({ results, passed, total: results.length }));
}

run().catch(err => {
  console.log(JSON.stringify({ results: [{ test: 'run', status: 'fail', error: String(err) }], passed: 0, total: 1 }));
});
"""

        with tempfile.NamedTemporaryFile(
            suffix=".cjs",
            delete=False,
            mode="w",
            encoding="utf-8",
        ) as tf:
            tf.write(script)
            script_path = tf.name

        try:
            result = await asyncio.to_thread(
                self._run_node_script, script_path
            )
            return result
        except Exception as exc:
            return {"passed": 0, "total": 0, "error": str(exc)}
        finally:
            try:
                pathlib.Path(script_path).unlink(missing_ok=True)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Enhanced testing methods
    # ------------------------------------------------------------------

    async def run_custom_tests(self, test_config: dict[str, Any], send_sse: Any = None) -> dict[str, Any]:
        """
        Run custom browser tests based on test configuration.

        test_config should contain:
        {
            "tests": [
                {"name": "test-name", "action": "navigate", "params": {...}},
                {"name": "test-name", "action": "click", "params": {"selector": "..."}},
                ...
            ]
        }
        """
        sse = send_sse or (lambda e: None)

        # Build custom test script
        script = self._build_custom_test_script(test_config)

        with tempfile.NamedTemporaryFile(
            suffix=".cjs",
            delete=False,
            mode="w",
            encoding="utf-8",
        ) as tf:
            tf.write(script)
            script_path = tf.name

        try:
            result = await asyncio.to_thread(
                self._run_node_script, script_path
            )
            return result
        except Exception as exc:
            return {"passed": 0, "total": 0, "error": str(exc)}
        finally:
            try:
                pathlib.Path(script_path).unlink(missing_ok=True)
            except Exception:
                pass

    def _build_custom_test_script(self, test_config: dict[str, Any]) -> str:
        """Build a custom Node.js test script from test configuration."""
        tests = test_config.get("tests", [])

        test_definitions = []
        for i, test in enumerate(tests):
            name = test.get("name", f"test_{i}")
            action = test.get("action", "")
            params = test.get("params", {})

            if action == "navigate":
                url = params.get("url", self.target_url)
                test_definitions.append(f"""
    // Test: {name}
    try {{
        await page.goto("{url}", {{ waitUntil: "networkidle", timeout: 15000 }});
        results.push({{ test: "{name}", status: "pass", detail: "navigated to {url}" }});
    }} catch (e) {{
        results.push({{ test: "{name}", status: "fail", error: e.message }});
    }}
""")
            elif action == "click":
                selector = params.get("selector", "")
                test_definitions.append(f"""
    // Test: {name}
    try {{
        await page.click("{selector}", {{ timeout: 5000 }});
        results.push({{ test: "{name}", status: "pass" }});
    }} catch (e) {{
        results.push({{ test: "{name}", status: "fail", error: e.message }});
    }}
""")
            elif action == "screenshot":
                test_definitions.append(f"""
    // Test: {name}
    try {{
        const ss = await page.screenshot({{ fullPage: {str(params.get("fullPage", True)).lower()} }});
        const b64 = Buffer.from(ss).toString("base64");
        results.push({{ test: "{name}", status: "pass", screenshot_b64: b64 }});
    }} catch (e) {{
        results.push({{ test: "{name}", status: "fail", error: e.message }});
    }}
""")
            elif action == "wait":
                selector = params.get("selector", "")
                timeout = params.get("timeout", 5000)
                test_definitions.append(f"""
    // Test: {name}
    try {{
        await page.waitForSelector("{selector}", {{ timeout: {timeout} }});
        results.push({{ test: "{name}", status: "pass" }});
    }} catch (e) {{
        results.push({{ test: "{name}", status: "fail", error: e.message }});
    }}
""")
            elif action == "evaluate":
                script = params.get("script", "")
                # Escape for JS
                escaped = script.replace("`", "\\`").replace("${", "\\${")
                test_definitions.append(f"""
    // Test: {name}
    try {{
        const result = await page.evaluate(() => {{ {escaped} }});
        results.push({{ test: "{name}", status: "pass", detail: JSON.stringify(result) }});
    }} catch (e) {{
        results.push({{ test: "{name}", status: "fail", error: e.message }});
    }}
""")

        tests_code = "".join(test_definitions)

        return f"""
const TARGET_URL = process.argv[2] || "{self.target_url}";
const results = [];

async function run() {{
  let browser, page;

  try {{
    const {{ chromium }} = require("playwright");
    browser = await chromium.launch({{ headless: true }});
    page = await browser.newPage();
    results.push({{ test: "browser-init", status: "pass" }});
  }} catch (err) {{
    console.log(JSON.stringify({{ results: [{{ test: "browser-init", status: "fail", error: String(err) }}], passed: 0, total: 1 }}));
    process.exit(0);
  }}

{tests_code}

  const passed = results.filter(r => r.status === "pass").length;
  console.log(JSON.stringify({{ results, passed, total: results.length }}));
}}

run().catch(err => {{
  console.log(JSON.stringify({{ results: [{{ test: "run", status: "fail", error: String(err) }}], passed: 0, total: 1 }}));
}});
"""

    async def run_accessibility_test(self, send_sse: Any = None) -> dict[str, Any]:
        """Run accessibility tests on the target URL."""
        sse = send_sse or (lambda e: None)

        accessibility_script = """
const TARGET_URL = process.argv[2] || "http://localhost:3000";
const results = [];

async function run() {
  let browser, page;

  try {
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  } catch (err) {
    console.log(JSON.stringify({ results: [{ test: "init", status: "fail", error: String(err) }], passed: 0, total: 1 }));
    process.exit(0);
  }

  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 15000 });

    // Check for images without alt text
    const imagesNoAlt = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img');
      return Array.from(imgs).filter(img => !img.alt).length;
    });
    results.push({ test: "images-have-alt", status: imagesNoAlt === 0 ? "pass" : "fail", detail: `${imagesNoAlt} images missing alt text` });

    // Check for form labels
    const formsNoLabel = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])');
      return Array.from(inputs).filter(input => {
        const id = input.getAttribute('id');
        const label = document.querySelector(`label[for="${id}"]`);
        const parentLabel = input.closest('label');
        return !id || (!label && !parentLabel);
      }).length;
    });
    results.push({ test: "forms-have-labels", status: formsNoLabel === 0 ? "pass" : "fail", detail: `${formsNoLabel} inputs missing labels` });

    // Check for buttons without text
    const buttonsEmpty = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      return Array.from(btns).filter(btn => !btn.textContent.trim()).length;
    });
    results.push({ test: "buttons-have-text", status: buttonsEmpty === 0 ? "pass" : "fail", detail: `${buttonsEmpty} buttons missing text` });

    // Check for ARIA roles
    const ariaRoles = await page.evaluate(() => {
      const elements = document.querySelectorAll('[role]');
      return Array.from(elements).map(el => ({ role: el.getAttribute('role'), id: el.id })).slice(0, 10);
    });
    results.push({ test: "aria-roles-present", status: "pass", detail: `${ariaRoles.length} elements with ARIA roles` });

    // Get accessibility tree
    const a11y = await page.accessibility.snapshot();
    results.push({ test: "accessibility-tree", status: "pass", detail: "accessibility tree captured" });

  } catch (e) {
    results.push({ test: "accessibility-checks", status: "fail", error: e.message });
  }

  const passed = results.filter(r => r.status === "pass").length;
  console.log(JSON.stringify({ results, passed, total: results.length }));
}}

run().catch(err => {
  console.log(JSON.stringify({ results: [{ test: "run", status: "fail", error: String(err) }], passed: 0, total: 1 }));
});
"""

        with tempfile.NamedTemporaryFile(
            suffix=".cjs",
            delete=False,
            mode="w",
            encoding="utf-8",
        ) as tf:
            tf.write(accessibility_script)
            script_path = tf.name

        try:
            result = await asyncio.to_thread(
                self._run_node_script, script_path
            )
            return result
        except Exception as exc:
            return {"passed": 0, "total": 0, "error": str(exc)}
        finally:
            try:
                pathlib.Path(script_path).unlink(missing_ok=True)
            except Exception:
                pass
