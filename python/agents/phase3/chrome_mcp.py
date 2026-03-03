"""
chrome_mcp.py — Phase 3 ChromeDevToolsMCP wrapper.
T110: Chrome DevTools Protocol via MCP to drive browser during implementation.
Provides: navigate, screenshot, evaluate_js, get_console_logs, click, type, wait_for.
Enhanced with: network interception, video recording, element capture, full console logs.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import tempfile
import time
from datetime import datetime
from typing import Any
from collections import defaultdict


class ChromeDevToolsMCP:
    """
    Thin wrapper around Chrome DevTools Protocol / Playwright MCP.
    Falls back to Playwright direct when MCP server not available.
    Enhanced with network interception, video recording, and full testing capabilities.
    """

    def __init__(
        self,
        mcp_url: str = "http://localhost:9222",
        playwright_headless: bool = True,
        record_video: bool = False,
    ):
        self.mcp_url = mcp_url
        self.playwright_headless = playwright_headless
        self.record_video = record_video
        self._playwright = None
        self._browser = None
        self._page = None
        self._context = None
        self._ws_url: str | None = None
        self._console_logs: list[dict] = []
        self._network_logs: list[dict] = []
        self._video_path: str | None = None

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> bool:
        """Connect to Chrome DevTools or Playwright."""
        # Try Playwright first (most reliable)
        try:
            from playwright.async_api import async_playwright  # type: ignore
            self._playwright = await async_playwright().__aenter__()

            # Launch browser with video recording if requested
            if self.record_video:
                self._context = await self._playwright.chromium.launch_persistent_context(
                    "",
                    headless=self.playwright_headless,
                    record_video_dir=tempfile.mkdtemp(),
                    record_video_size={"width": 1280, "height": 720},
                )
                self._page = await self._context.new_page()
                self._browser = self._context.browser
            else:
                self._browser = await self._playwright.chromium.launch(headless=self.playwright_headless)
                self._page = await self._browser.new_page()

            # Set up console log capture
            if self._page:
                self._page.on("console", lambda msg: self._console_logs.append({
                    "type": msg.type,
                    "text": msg.text,
                    "timestamp": datetime.now().isoformat(),
                }))
                self._page.on("request", lambda req: self._network_logs.append({
                    "method": req.method,
                    "url": req.url,
                    "timestamp": datetime.now().isoformat(),
                    "type": req.resource_type,
                }))
                self._page.on("response", lambda resp: self._network_logs.append({
                    "method": resp.request.method,
                    "url": resp.url,
                    "status": resp.status,
                    "timestamp": datetime.now().isoformat(),
                }))

            return True
        except ImportError:
            pass
        # Try CDP via httpx
        try:
            import httpx
            resp = httpx.get(f"{self.mcp_url}/json/version", timeout=3)
            self._ws_url = resp.json().get("webSocketDebuggerUrl")
            return self._ws_url is not None
        except Exception:
            return False

    async def disconnect(self) -> None:
        """Disconnect and cleanup."""
        # Get video path before closing
        if self._context and self.record_video:
            try:
                self._video_path = await self._context.video.path()
            except Exception:
                pass

        if self._browser:
            try:
                await self._browser.close()
            except Exception:
                pass
        if self._playwright:
            try:
                await self._playwright.__aexit__(None, None, None)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Browser actions
    # ------------------------------------------------------------------

    async def navigate(self, url: str) -> dict[str, Any]:
        if self._page:
            try:
                await self._page.goto(url, wait_until="networkidle", timeout=30000)
                return {"status": "ok", "url": url}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def screenshot(self, full_page: bool = True) -> str:
        """Returns base64 PNG."""
        if self._page:
            try:
                png = await self._page.screenshot(full_page=full_page)
                return base64.b64encode(png).decode()
            except Exception:
                pass
        return ""

    async def evaluate_js(self, script: str) -> Any:
        if self._page:
            try:
                return await self._page.evaluate(script)
            except Exception as e:
                return {"error": str(e)}
        return None

    async def get_console_logs(self, clear: bool = True) -> list[dict]:
        """Return accumulated console logs with timestamps."""
        logs = self._console_logs.copy()
        if clear:
            self._console_logs.clear()
        return logs

    async def click(self, selector: str) -> dict:
        if self._page:
            try:
                await self._page.click(selector, timeout=5000)
                return {"status": "ok", "selector": selector}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def type_text(self, selector: str, text: str) -> dict:
        if self._page:
            try:
                await self._page.fill(selector, text)
                return {"status": "ok"}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def wait_for(self, selector: str, timeout: float = 10.0) -> dict:
        if self._page:
            try:
                await self._page.wait_for_selector(selector, timeout=int(timeout * 1000))
                return {"status": "ok", "selector": selector}
            except Exception as e:
                return {"status": "timeout", "error": str(e)}
        return {"status": "no_connection"}

    async def get_page_title(self) -> str:
        if self._page:
            try:
                return await self._page.title()
            except Exception:
                pass
        return ""

    async def get_accessibility_tree(self) -> dict:
        """Get accessibility snapshot for element analysis."""
        if self._page:
            try:
                snapshot = await self._page.accessibility.snapshot()
                return snapshot or {}
            except Exception:
                pass
        return {}

    # ------------------------------------------------------------------
    # Enhanced browser testing features
    # ------------------------------------------------------------------

    async def get_network_logs(self, clear: bool = True) -> list[dict]:
        """Return network request/response logs."""
        logs = self._network_logs.copy()
        if clear:
            self._network_logs.clear()
        return logs

    async def get_network_requests(self, url_pattern: str | None = None) -> list[dict]:
        """Get network requests, optionally filtered by URL pattern."""
        requests = []
        for log in self._network_logs:
            if log.get("method") and (not url_pattern or url_pattern in log.get("url", "")):
                requests.append(log)
        return requests

    async def get_failed_requests(self) -> list[dict]:
        """Get all failed network requests (4xx/5xx)."""
        failed = []
        for log in self._network_logs:
            status = log.get("status")
            if status and status >= 400:
                failed.append(log)
        return failed

    async def take_element_screenshot(self, selector: str, path: str | None = None) -> str:
        """Take screenshot of a specific element."""
        if not self._page:
            return ""
        try:
            element = await self._page.query_selector(selector)
            if element:
                png = await element.screenshot()
                b64 = base64.b64encode(png).decode()
                if path:
                    import pathlib
                    pathlib.Path(path).write_bytes(base64.b64decode(b64))
                return b64
        except Exception:
            pass
        return ""

    async def hover(self, selector: str) -> dict:
        """Hover over an Element."""
        if self._page:
            try:
                await self._page.hover(selector, timeout=5000)
                return {"status": "ok", "selector": selector}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def double_click(self, selector: str) -> dict:
        """Double-click an element."""
        if self._page:
            try:
                await self._page.dblclick(selector, timeout=5000)
                return {"status": "ok", "selector": selector}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def right_click(self, selector: str) -> dict:
        """Right-click (context menu) an element."""
        if self._page:
            try:
                await self._page.click(selector, button="right", timeout=5000)
                return {"status": "ok", "selector": selector}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def scroll_to(self, selector: str) -> dict:
        """Scroll element into view."""
        if self._page:
            try:
                await self._page.evaluate(
                    f"""(selector) => {{
                        const el = document.querySelector(selector);
                        if (el) el.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                    }}""",
                    selector,
                )
                return {"status": "ok", "selector": selector}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def get_element_attributes(self, selector: str) -> dict:
        """Get all attributes of an element."""
        if self._page:
            try:
                attrs = await self._page.evaluate(
                    """(selector) => {
                        const el = document.querySelector(selector);
                        if (!el) return null;
                        const attrs = {};
                        for (const attr of el.attributes) {
                            attrs[attr.name] = attr.value;
                        }
                        return attrs;
                    }""",
                    selector,
                )
                return attrs or {}
            except Exception:
                pass
        return {}

    async def get_all_links(self) -> list[dict]:
        """Get all links on the page with their text and href."""
        if self._page:
            try:
                links = await self._page.evaluate("""() => {
                    const anchors = document.querySelectorAll('a');
                    return Array.from(anchors).map(a => ({
                        text: a.textContent?.trim() || '',
                        href: a.href,
                        target: a.target
                    }));
                }""")
                return links
            except Exception:
                pass
        return []

    async def get_all_images(self) -> list[dict]:
        """Get all images on the page."""
        if self._page:
            try:
                images = await self._page.evaluate("""() => {
                    const imgs = document.querySelectorAll('img');
                    return Array.from(imgs).map(img => ({
                        src: img.src,
                        alt: img.alt,
                        naturalWidth: img.naturalWidth,
                        naturalHeight: img.naturalHeight,
                        loaded: img.complete
                    }));
                }""")
                return images
            except Exception:
                pass
        return []

    async def get_forms(self) -> list[dict]:
        """Get all forms on the page with their inputs."""
        if self._page:
            try:
                forms = await self._page.evaluate("""() => {
                    const forms = document.querySelectorAll('form');
                    return Array.from(forms).map((form, idx) => {
                        const inputs = Array.from(form.querySelectorAll('input, textarea, select'))
                            .map(input => ({
                                name: input.name,
                                type: input.type,
                                id: input.id,
                                required: input.required
                            }));
                        return {
                            id: form.id,
                            action: form.action,
                            method: form.method,
                            inputs
                        };
                    });
                }""")
                return forms
            except Exception:
                pass
        return []

    async def is_element_visible(self, selector: str) -> bool:
        """Check if element is visible."""
        if self._page:
            try:
                return await self._page.is_visible(selector)
            except Exception:
                pass
        return False

    async def wait_for_navigation(self, timeout: float = 30.0) -> dict:
        """Wait for page navigation to complete."""
        if self._page:
            try:
                await self._page.wait_for_load_state("networkidle", timeout=timeout * 1000)
                return {"status": "ok", "url": self._page.url}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def get_cookies(self) -> list[dict]:
        """Get all cookies for the current page."""
        if self._page:
            try:
                cookies = await self._page.context.cookies()
                return [{"name": c["name"], "value": c["value"], "domain": c["domain"]} for c in cookies]
            except Exception:
                pass
        return []

    async def set_cookies(self, cookies: list[dict]) -> dict:
        """Set cookies for the current page."""
        if self._page:
            try:
                await self._page.context.add_cookies(cookies)
                return {"status": "ok", "count": len(cookies)}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def clear_cookies(self) -> dict:
        """Clear all cookies."""
        if self._page:
            try:
                await self._page.context.clear_cookies()
                return {"status": "ok"}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def set_viewport(self, width: int = 1280, height: int = 720) -> dict:
        """Set viewport size."""
        if self._page:
            try:
                await self._page.set_viewport_size({"width": width, "height": height})
                return {"status": "ok", "width": width, "height": height}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def get_js_errors(self) -> list[str]:
        """Get JavaScript errors from the page."""
        if self._page:
            try:
                errors = await self._page.evaluate("""() => {
                    return window.__jsErrors || [];
                }""")
                return errors
            except Exception:
                pass
        return []

    async def inject_js_error_capture(self) -> dict:
        """Inject JS to capture console errors."""
        if self._page:
            try:
                await self._page.add_init_script("""() => {
                    window.__jsErrors = [];
                    window.addEventListener('error', (e) => {
                        window.__jsErrors.push(e.message);
                    });
                    window.addEventListener('unhandledrejection', (e) => {
                        window.__jsErrors.push('Unhandled rejection: ' + e.reason);
                    });
                }""")
                return {"status": "ok"}
            except Exception as e:
                return {"status": "error", "error": str(e)}
        return {"status": "no_connection"}

    async def get_performance_metrics(self) -> dict:
        """Get page performance metrics."""
        if self._page:
            try:
                metrics = await self._page.evaluate("""() => {
                    const perfData = window.performance ? window.performance.timing : null;
                    return {
                        loadTime: perfData ? perfData.loadEventEnd - perfData.navigationStart : 0,
                        domContentLoaded: perfData ? perfData.domContentLoadedEventEnd - perfData.navigationStart : 0,
                        firstPaint: perfData ? perfData.responseEnd - perfData.navigationStart : 0
                    };
                }""")
                return metrics
            except Exception:
                pass
        return {}

    async def save_video(self, path: str) -> str | None:
        """
        Save recorded video to path and upload to cloud storage (T-MEDIA-03).
        Returns the CDN URL if upload succeeds, otherwise the local path.
        """
        if self._video_path and path:
            try:
                import shutil
                shutil.copy(self._video_path, path)
                # T-MEDIA-03: Upload to cloud storage
                try:
                    import sys, os as _os
                    _tools_dir = _os.path.join(_os.path.dirname(__file__), "..", "..", "tools")
                    if _tools_dir not in sys.path:
                        sys.path.insert(0, _os.path.abspath(_tools_dir))
                    from storage import StorageTool  # type: ignore
                    _is_pro = (_os.environ.get("PAKALON_PLAN", "free").lower() in ("pro", "enterprise"))
                    _st = StorageTool()
                    _up = _st.upload_for_tier(path, remote_key=f"videos/{_os.path.basename(path)}", is_pro=_is_pro)
                    if _up.get("success") and _up.get("url"):
                        return _up["url"]  # CDN or signed URL
                except Exception:
                    pass
                return path
            except Exception:
                pass
        return None

    # ------------------------------------------------------------------
    # E-04: capture_recording — record full browser session as video
    # ------------------------------------------------------------------

    async def capture_recording(
        self,
        url: str,
        duration_s: float = 10.0,
        actions: list[dict] | None = None,
        output_path: str | None = None,
    ) -> str | None:
        """
        Record a browser session as a video file.

        Opens `url`, optionally performs `actions` (click/type/wait), waits for
        `duration_s`, then saves the recording to `output_path` (default: a
        temp file). Returns the path to the video file, or None on failure.

        Each action dict: {"type": "click"|"type"|"wait"|"navigate", "selector": "...", "value": "..."}
        """
        import tempfile

        if output_path is None:
            tmp = tempfile.NamedTemporaryFile(suffix=".webm", delete=False)
            output_path = tmp.name
            tmp.close()

        # Re-launch with video recording enabled
        try:
            from playwright.async_api import async_playwright  # type: ignore

            async with async_playwright() as pw:
                with tempfile.TemporaryDirectory() as vid_dir:
                    ctx = await pw.chromium.launch_persistent_context(
                        "",
                        headless=self.playwright_headless,
                        record_video_dir=vid_dir,
                        record_video_size={"width": 1280, "height": 720},
                    )
                    page = await ctx.new_page()

                    await page.goto(url, wait_until="networkidle", timeout=30_000)

                    # Execute optional actions
                    for action in (actions or []):
                        atype = action.get("type", "")
                        sel = action.get("selector", "")
                        val = action.get("value", "")
                        try:
                            if atype == "click" and sel:
                                await page.click(sel, timeout=5_000)
                            elif atype == "type" and sel:
                                await page.fill(sel, val, timeout=5_000)
                            elif atype == "wait":
                                await asyncio.sleep(float(val or 1))
                            elif atype == "navigate" and val:
                                await page.goto(val, wait_until="networkidle", timeout=15_000)
                        except Exception:
                            pass  # non-fatal

                    await asyncio.sleep(duration_s)
                    await ctx.close()

                    # Move the recorded video out of the temp dir
                    import shutil
                    import os
                    vids = [f for f in os.listdir(vid_dir) if f.endswith(".webm")]
                    if vids:
                        src = os.path.join(vid_dir, vids[0])
                        shutil.copy2(src, output_path)
                        self._video_path = output_path
                        return output_path
        except Exception:
            pass

        return None

    # ------------------------------------------------------------------
    # E-05: generate_test_report — comprehensive automated test report
    # ------------------------------------------------------------------

    async def generate_test_report(
        self,
        url: str,
        user_stories: list[str] | None = None,
        output_dir: str | None = None,
    ) -> dict:
        """
        Run a battery of automated checks against `url` and return a
        structured test report dict.  Optionally write JSON + Markdown
        summary to `output_dir`.

        Checks performed:
          - Page loads (200 response)
          - Console errors count
          - Accessibility tree node count
          - Failed network requests
          - Form field discovery
          - Page title present
          - JS errors

        Returns:
            {
                "url": str,
                "timestamp": str,
                "pass_count": int,
                "fail_count": int,
                "checks": [{"name": str, "status": "pass"|"fail"|"warn", "detail": str}],
                "console_errors": [...],
                "failed_requests": [...],
                "screenshot_path": str | None,
                "user_story_results": [{"story": str, "status": str}],
            }
        """
        from datetime import datetime as _dt
        import json as _json

        report: dict = {
            "url": url,
            "timestamp": _dt.utcnow().isoformat(),
            "pass_count": 0,
            "fail_count": 0,
            "checks": [],
            "console_errors": [],
            "failed_requests": [],
            "screenshot_path": None,
            "user_story_results": [],
        }

        def _add(name: str, status: str, detail: str = "") -> None:
            report["checks"].append({"name": name, "status": status, "detail": detail})
            if status == "pass":
                report["pass_count"] += 1
            elif status == "fail":
                report["fail_count"] += 1

        try:
            connected = await self.connect()
            if not connected:
                _add("browser_connect", "fail", "Could not launch browser")
                return report

            nav = await self.navigate(url)
            if nav.get("status") == "ok":
                _add("page_loads", "pass", nav.get("status_code", "200"))
            else:
                _add("page_loads", "fail", str(nav))

            title = await self.get_page_title()
            _add("page_title_present", "pass" if title else "warn", title or "No title found")

            console_logs = await self.get_console_logs(clear=False)
            errors = [lg for lg in console_logs if lg.get("type") in ("error", "warning")]
            report["console_errors"] = errors[:20]
            _add("console_errors", "warn" if errors else "pass", f"{len(errors)} error(s)")

            js_errors = await self.get_js_errors()
            _add("js_errors", "fail" if js_errors else "pass", "; ".join(js_errors[:5]))

            failed_reqs = await self.get_failed_requests()
            report["failed_requests"] = failed_reqs[:20]
            _add("no_failed_requests", "fail" if failed_reqs else "pass", f"{len(failed_reqs)} failed")

            acc_tree = await self.get_accessibility_tree()
            node_count = len(acc_tree.get("nodes", [])) if isinstance(acc_tree, dict) else 0
            _add("accessibility_nodes", "pass" if node_count > 0 else "warn", f"{node_count} nodes")

            forms = await self.get_forms()
            _add("forms_discoverable", "pass" if forms is not None else "warn", f"{len(forms or [])} form(s)")

            perf = await self.get_performance_metrics()
            load_ms = perf.get("loadTime", 0)
            _add(
                "page_load_time",
                "pass" if load_ms < 3000 else "warn",
                f"{load_ms} ms" if load_ms else "N/A",
            )

            # Screenshot
            try:
                ss_b64 = await self.screenshot(full_page=False)
                if ss_b64 and output_dir:
                    import base64, os, pathlib
                    ss_dir = pathlib.Path(output_dir)
                    ss_dir.mkdir(parents=True, exist_ok=True)
                    ss_path = str(ss_dir / "test-report-screenshot.png")
                    pathlib.Path(ss_path).write_bytes(base64.b64decode(ss_b64))
                    report["screenshot_path"] = ss_path
                    # T-MEDIA-03: Upload screenshot to cloud storage
                    try:
                        import sys, os as _os
                        _tools_dir = _os.path.join(_os.path.dirname(__file__), "..", "..", "tools")
                        if _tools_dir not in sys.path:
                            sys.path.insert(0, _os.path.abspath(_tools_dir))
                        from storage import StorageTool  # type: ignore
                        _is_pro = (_os.environ.get("PAKALON_PLAN", "free").lower() in ("pro", "enterprise"))
                        _st = StorageTool()
                        _up = _st.upload_for_tier(ss_path, remote_key=f"screenshots/test-{_os.path.basename(ss_path)}", is_pro=_is_pro)
                        if _up.get("success"):
                            report["screenshot_url"] = _up["url"]
                            report["screenshot_url_type"] = _up.get("url_type", "public")
                    except Exception:
                        pass  # storage upload is best-effort
                _add("screenshot_captured", "pass" if ss_b64 else "warn")
            except Exception:
                _add("screenshot_captured", "warn", "Screenshot failed")

            # User-story check via LLM if possible
            for story in (user_stories or []):
                report["user_story_results"].append({"story": story, "status": "manual_review"})

            await self.disconnect()

        except Exception as exc:
            _add("test_run", "fail", str(exc))

        # Persist report if output_dir provided
        if output_dir:
            import pathlib as _pl
            _pl.Path(output_dir).mkdir(parents=True, exist_ok=True)
            rpt_json = _pl.Path(output_dir) / "test-report.json"
            rpt_json.write_text(_json.dumps(report, indent=2))

            # Markdown summary
            lines = [
                f"# Test Report: {url}",
                f"\n*Generated: {report['timestamp']}*\n",
                f"**Pass:** {report['pass_count']}  **Fail:** {report['fail_count']}\n",
                "## Checks\n",
                "| Check | Status | Detail |",
                "|-------|--------|--------|",
            ]
            for c in report["checks"]:
                icon = "✅" if c["status"] == "pass" else ("⚠️" if c["status"] == "warn" else "❌")
                lines.append(f"| {c['name']} | {icon} {c['status']} | {c['detail']} |")
            if report.get("screenshot_url") or report.get("screenshot_path"):
                img_ref = report.get("screenshot_url") or report["screenshot_path"]
                lines.append(f"\n## Screenshot\n\n![screenshot]({img_ref})\n")
            (_pl.Path(output_dir) / "test-report.md").write_text("\n".join(lines))

        return report


    # ------------------------------------------------------------------
    # Automated regression test runner
    # ------------------------------------------------------------------

    async def run_automated_regression_tests(
        self,
        base_url: str,
        routes: list[str] | None = None,
        output_dir: str | None = None,
        click_all_buttons: bool = True,
        fill_forms: bool = True,
        screenshot_on_error: bool = True,
    ) -> dict:
        """
        Automated regression test suite.

        For every route in ``routes`` (defaults to ``["/"]`` if not provided):

        1. Navigate to ``base_url + route``
        2. Inject a global error collector (JS console + unhandledrejection)
        3. Capture baseline accessibility snapshot
        4. Click every visible button/link and record JS errors + failed requests
        5. Fill every form with sensible synthetic data and submit it; record errors
        6. Capture a final screenshot (on error only unless ``screenshot_on_error=False``)

        Returns a structured regression report that Phase-3 sub-agents can consume:

        .. code-block:: json

            {
              "summary": {"total_routes": 2, "failed_routes": 1, "total_errors": 5},
              "routes": [
                {
                  "route": "/login",
                  "url": "http://localhost:3000/login",
                  "status": "fail",
                  "js_errors": [...],
                  "failed_requests": [...],
                  "interactions": [
                    {"type": "click", "target": "button#login", "js_errors": [], "failed_requests": []},
                    {"type": "form_submit", "form_index": 0, "js_errors": [...], "failed_requests": []}
                  ],
                  "screenshot_path": "/tmp/regression/login_error.png"
                }
              ]
            }

        """
        import pathlib as _pl
        routes = routes or ["/"]
        route_results: list[dict] = []
        total_errors = 0
        failed_routes = 0

        # JS snippet injected into every page to collect runtime errors
        _error_injector = """
        window.__regressionErrors = [];
        window.__regressionFailedRequests = [];
        window.onerror = function(msg, src, line, col, err) {
            window.__regressionErrors.push({type:'onerror', message: msg, source: src, line: line});
        };
        window.addEventListener('unhandledrejection', function(e) {
            window.__regressionErrors.push({type:'unhandledrejection', message: String(e.reason)});
        });
        // Intercept fetch to log failures
        const _origFetch = window.fetch;
        window.fetch = async function(...args) {
            try {
                const r = await _origFetch.apply(this, args);
                if (!r.ok) {
                    window.__regressionFailedRequests.push({url: args[0], status: r.status});
                }
                return r;
            } catch(e) {
                window.__regressionFailedRequests.push({url: args[0], error: String(e)});
                throw e;
            }
        };
        """

        _collect_errors_js = """
        ({
            js_errors: window.__regressionErrors || [],
            failed_requests: window.__regressionFailedRequests || []
        })
        """

        def _clear_errors_js() -> str:
            return (
                "window.__regressionErrors = []; "
                "window.__regressionFailedRequests = [];"
            )

        async def _gather_interactables() -> dict:
            """Return lists of button/link selectors and form information via JS."""
            return await self.execute_script("""
            const buttons = Array.from(document.querySelectorAll(
                'button:not([disabled]), [role="button"], input[type="submit"], input[type="button"]'
            )).slice(0, 20).map((el, i) => ({
                selector: el.id ? '#' + el.id : el.getAttribute('data-testid')
                    ? '[data-testid="' + el.getAttribute('data-testid') + '"]'
                    : el.tagName.toLowerCase() + ':nth-of-type(' + (i+1) + ')',
                text: (el.textContent || el.value || '').trim().slice(0, 60),
                type: 'button'
            }));
            const links = Array.from(document.querySelectorAll('a[href]'))
                .filter(a => {
                    const href = a.getAttribute('href');
                    return href && !href.startsWith('mailto:') && !href.startsWith('javascript:');
                })
                .slice(0, 10)
                .map((a, i) => ({
                    selector: a.id ? '#' + a.id : 'a:nth-of-type(' + (i+1) + ')',
                    href: a.getAttribute('href'),
                    text: a.textContent.trim().slice(0, 60),
                    type: 'link'
                }));
            const forms = Array.from(document.querySelectorAll('form')).map((form, fi) => ({
                index: fi,
                action: form.getAttribute('action') || '',
                method: (form.getAttribute('method') || 'GET').toUpperCase(),
                fields: Array.from(form.querySelectorAll('input,textarea,select'))
                    .filter(el => el.type !== 'hidden' && el.type !== 'submit')
                    .map(el => ({
                        name: el.name || el.id || '',
                        type: el.type || el.tagName.toLowerCase(),
                        required: el.required,
                    }))
            }));
            return { buttons, links, forms };
            """)

        async def _autofill_form(form_index: int, fields: list[dict]) -> None:
            """Fill form fields with synthetic test data."""
            for field in fields:
                ftype = (field.get("type") or "").lower()
                fname = (field.get("name") or "").lower()
                val: str
                if "email" in ftype or "email" in fname:
                    val = "test@regression.pakalon.local"
                elif "password" in ftype or "password" in fname:
                    val = "TestP@ss1234!"
                elif "phone" in ftype or "tel" in ftype or "phone" in fname:
                    val = "+12025550100"
                elif "url" in ftype or "url" in fname:
                    val = "https://regression.pakalon.local"
                elif ftype == "number":
                    val = "42"
                elif ftype in ("checkbox", "radio"):
                    await self.execute_script(f"""
                    const el = document.querySelectorAll('form')[{form_index}]
                        .querySelectorAll('input[type="{ftype}"]')[0];
                    if (el) el.checked = true;
                    """)
                    continue
                elif ftype == "select":
                    await self.execute_script(f"""
                    const sel = document.querySelectorAll('form')[{form_index}]
                        .querySelectorAll('select')[0];
                    if (sel && sel.options.length > 1) sel.selectedIndex = 1;
                    """)
                    continue
                else:
                    val = "Regression test input"

                field_name = field.get("name", "")
                if field_name:
                    await self.execute_script(f"""
                    const form = document.querySelectorAll('form')[{form_index}];
                    const el = form.querySelector('[name="{field_name}"]');
                    if (el) {{ el.value = {json.dumps(val)}; el.dispatchEvent(new Event('input', {{bubbles:true}})); }}
                    """)

        for route in routes:
            route_url = base_url.rstrip("/") + route
            route_record: dict = {
                "route": route,
                "url": route_url,
                "status": "pass",
                "js_errors": [],
                "failed_requests": [],
                "interactions": [],
                "accessibility_violations": [],
                "screenshot_path": None,
            }

            try:
                await self.navigate(route_url)
                await self.execute_script(_error_injector)
                await asyncio.sleep(1.0)  # allow page to settle

                # Baseline JS errors
                baseline = await self.execute_script(_collect_errors_js)
                route_record["js_errors"] = baseline.get("js_errors", [])
                route_record["failed_requests"] = baseline.get("failed_requests", [])
                await self.execute_script(_clear_errors_js())

                # Accessibility snapshot
                try:
                    a11y = await self.get_accessibility_tree()
                    violations = [
                        n for n in (a11y if isinstance(a11y, list) else [])
                        if "violation" in str(n).lower()
                    ]
                    route_record["accessibility_violations"] = violations[:10]
                except Exception:
                    pass

                # Discover interactable elements
                interactables = await _gather_interactables()

                # --- Click buttons ---
                if click_all_buttons:
                    for btn in interactables.get("buttons", [])[:15]:
                        interaction: dict = {
                            "type": "click",
                            "target": btn.get("selector", ""),
                            "text": btn.get("text", ""),
                            "js_errors": [],
                            "failed_requests": [],
                        }
                        try:
                            await self.click(btn["selector"])
                            await asyncio.sleep(0.5)
                            errs = await self.execute_script(_collect_errors_js)
                            interaction["js_errors"] = errs.get("js_errors", [])
                            interaction["failed_requests"] = errs.get("failed_requests", [])
                            await self.execute_script(_clear_errors_js())
                            # Navigate back if we left the page
                            cur_url = await self.execute_script("window.location.href")
                            if cur_url and not cur_url.startswith(base_url):
                                await self.navigate(route_url)
                                await self.execute_script(_error_injector)
                        except Exception as e:
                            interaction["error"] = str(e)
                        route_record["interactions"].append(interaction)
                        total_errors += len(interaction.get("js_errors", []))

                # --- Fill + submit forms ---
                if fill_forms:
                    for form in interactables.get("forms", [])[:5]:
                        form_record: dict = {
                            "type": "form_submit",
                            "form_index": form["index"],
                            "action": form.get("action", ""),
                            "method": form.get("method", "GET"),
                            "js_errors": [],
                            "failed_requests": [],
                        }
                        try:
                            await _autofill_form(form["index"], form.get("fields", []))
                            await asyncio.sleep(0.3)
                            # Submit without triggering a hard navigation
                            await self.execute_script(f"""
                            const form = document.querySelectorAll('form')[{form['index']}];
                            if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
                            """)
                            await asyncio.sleep(1.0)
                            errs = await self.execute_script(_collect_errors_js)
                            form_record["js_errors"] = errs.get("js_errors", [])
                            form_record["failed_requests"] = errs.get("failed_requests", [])
                            await self.execute_script(_clear_errors_js())
                        except Exception as e:
                            form_record["error"] = str(e)
                        route_record["interactions"].append(form_record)
                        total_errors += len(form_record.get("js_errors", []))

                # Determine route status
                all_errors = (
                    route_record["js_errors"]
                    + [e for i in route_record["interactions"] for e in i.get("js_errors", [])]
                )
                if all_errors:
                    route_record["status"] = "fail"
                    failed_routes += 1

                # Screenshot on error (or always if screenshot_on_error is False meaning "always capture")
                if route_record["status"] == "fail" or not screenshot_on_error:
                    if output_dir:
                        ss_dir = _pl.Path(output_dir)
                        ss_dir.mkdir(parents=True, exist_ok=True)
                        safe_route = route.strip("/").replace("/", "_") or "root"
                        ss_path = str(ss_dir / f"{safe_route}.png")
                        try:
                            await self.screenshot(ss_path)
                            route_record["screenshot_path"] = ss_path
                        except Exception:
                            pass

            except Exception as exc:
                route_record["status"] = "error"
                route_record["error"] = str(exc)
                failed_routes += 1

            route_results.append(route_record)

        report = {
            "type": "automated_regression",
            "timestamp": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "base_url": base_url,
            "summary": {
                "total_routes": len(routes),
                "failed_routes": failed_routes,
                "passed_routes": len(routes) - failed_routes,
                "total_errors": total_errors,
                "pass": failed_routes == 0,
            },
            "routes": route_results,
        }

        # Persist report
        if output_dir:
            _pl.Path(output_dir).mkdir(parents=True, exist_ok=True)
            rpt_path = _pl.Path(output_dir) / "regression-report.json"
            rpt_path.write_text(json.dumps(report, indent=2))

            # Markdown summary
            lines = [
                "# Automated Regression Report",
                f"\n*Base URL:* `{base_url}`  *Generated:* {report['timestamp']}\n",
                "| Route | Status | JS Errors | Failed Requests |",
                "|-------|--------|-----------|----------------|",
            ]
            for rr in route_results:
                n_js = len(rr.get("js_errors", []))
                n_req = len(rr.get("failed_requests", []))
                icon = "✅" if rr["status"] == "pass" else "❌"
                lines.append(f"| `{rr['route']}` | {icon} {rr['status']} | {n_js} | {n_req} |")
            (_pl.Path(output_dir) / "regression-report.md").write_text("\n".join(lines))

        return report

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *args):
        await self.disconnect()
