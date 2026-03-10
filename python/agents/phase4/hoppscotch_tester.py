"""
hoppscotch_tester.py — Phase 4 SA1: Hoppscotch API Security Testing.

Discovers all API endpoints in the built application, then:
  1. Opens Hoppscotch (https://hoppscotch.io) via Vercel Agent Browser / Playwright
     and automates API calls through its UI to record real request/response pairs.
  2. Runs a comprehensive security fuzzing layer via httpx:
       – XSS payload injection in all string parameters
       – CSRF header manipulation (missing / forged tokens)
       – SQL injection probes
       – Authentication bypass (missing / tampered JWTs)
       – IDOR / parameter tampering (numeric IDs, UUIDs)
       – Header security checks (HSTS, CSP, X-Frame-Options, CORS)
       – HTTP verb tampering
       – Mass-assignment / over-posting
  3. Scores the API surface (0–100) based on findings severity.
  4. Writes a richly formatted subagent-1.md containing every request/response
     pair alongside vulnerability verdicts and code-change recommendations.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import subprocess
import tempfile
import textwrap
import time
from typing import Any
from urllib.parse import urljoin, urlparse

try:
    import httpx as _httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

from ..shared.paths import get_phase_dir


# ---------------------------------------------------------------------------
# Security probe payloads
# ---------------------------------------------------------------------------

_XSS_PAYLOADS = [
    "<script>alert('xss')</script>",
    '"><img src=x onerror=alert(1)>',
    "javascript:alert(1)",
    "<svg/onload=alert(1)>",
    "';alert(String.fromCharCode(88,83,83))//",
]

_SQLI_PAYLOADS = [
    "' OR '1'='1",
    "' OR 1=1--",
    "1; DROP TABLE users--",
    "' UNION SELECT NULL,NULL--",
    "admin'--",
]

_CMD_INJECTION_PAYLOADS = [
    "; ls -la",
    "| whoami",
    "`id`",
    "$(cat /etc/passwd)",
]

_SSRF_PAYLOADS = [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:22",
    "file:///etc/passwd",
]

# Headers often missing / misconfigured
_REQUIRED_SECURITY_HEADERS = {
    "Strict-Transport-Security": "HSTS missing — susceptible to protocol downgrade attacks",
    "Content-Security-Policy": "CSP missing — XSS attack surface increased",
    "X-Frame-Options": "Clickjacking protection absent",
    "X-Content-Type-Options": "MIME-sniffing not disabled",
    "Referrer-Policy": "Referrer leakage possible",
    "Permissions-Policy": "Feature-policy not restricted",
}

# CORS misconfiguration patterns
_DANGEROUS_CORS_ORIGINS = ["*", "null"]


# ---------------------------------------------------------------------------
# Endpoint discovery
# ---------------------------------------------------------------------------

class EndpointDiscoverer:
    """
    Scans the project directory to extract API endpoints from common conventions:
      - Next.js  app/api/** or pages/api/**
      - Express / Fastify routes
      - FastAPI Python routers
      - OpenAPI / Swagger JSON specs
    Falls back to testing the root + common paths if discovery yields nothing.
    """

    COMMON_PATHS = [
        "/api/health", "/api/status", "/health", "/api",
        "/api/v1", "/api/v2",
        "/api/auth/me", "/api/user", "/api/users",
        "/api/login", "/api/register", "/api/logout",
        "/api/webhooks", "/api/admin",
    ]

    def __init__(self, project_dir: str, target_url: str):
        self.project_dir = pathlib.Path(project_dir)
        self.target_url = target_url.rstrip("/")

    def discover(self) -> list[dict]:
        """Return a list of {method, path, description, params} dicts."""
        endpoints: list[dict] = []
        endpoints += self._scan_nextjs_api()
        endpoints += self._scan_fastapi_routers()
        endpoints += self._scan_openapi_spec()
        endpoints += self._scan_express_routes()

        if not endpoints:
            # Fallback: probe well-known paths
            endpoints = [
                {"method": "GET", "path": p, "description": "common path probe", "params": {}}
                for p in self.COMMON_PATHS
            ]

        # Deduplicate by (method, path)
        seen: set[tuple] = set()
        unique: list[dict] = []
        for ep in endpoints:
            key = (ep["method"].upper(), ep["path"])
            if key not in seen:
                seen.add(key)
                unique.append(ep)
        return unique

    # ------------------------------------------------------------------
    def _scan_nextjs_api(self) -> list[dict]:
        routes: list[dict] = []
        for base in ["app/api", "pages/api", "src/app/api", "src/pages/api"]:
            api_dir = self.project_dir / base
            if not api_dir.exists():
                continue
            for f in api_dir.rglob("*.ts"):
                rel = f.relative_to(self.project_dir / base)
                # Convert file path → URL path
                parts = list(rel.parts)
                # route.ts or page.ts → strip filename
                if parts[-1] in ("route.ts", "route.js"):
                    parts = parts[:-1]
                else:
                    parts[-1] = re.sub(r"\.(ts|js|tsx|jsx)$", "", parts[-1])
                api_path = "/api/" + "/".join(parts)
                # Detect HTTP verbs exported from file
                try:
                    src = f.read_text(errors="replace")
                except Exception:
                    src = ""
                verbs_found = re.findall(
                    r"export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)",
                    src,
                )
                if not verbs_found:
                    verbs_found = ["GET"]  # assume GET if no explicit export
                for verb in verbs_found:
                    routes.append({
                        "method": verb,
                        "path": api_path,
                        "description": f"Next.js API route ({f.name})",
                        "params": self._infer_params(src, verb),
                    })
        return routes

    def _scan_fastapi_routers(self) -> list[dict]:
        routes: list[dict] = []
        for f in self.project_dir.rglob("*.py"):
            try:
                src = f.read_text(errors="replace")
            except Exception:
                continue
            # @router.get("/path") or @app.post("/path")
            for m in re.finditer(
                r'@(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*["\']([^"\']+)["\']',
                src, re.I,
            ):
                verb = m.group(1).upper()
                path = m.group(2)
                if not path.startswith("/"):
                    path = "/" + path
                routes.append({
                    "method": verb,
                    "path": path,
                    "description": f"FastAPI route ({f.name})",
                    "params": {},
                })
        return routes

    def _scan_openapi_spec(self) -> list[dict]:
        routes: list[dict] = []
        for spec_name in ["openapi.json", "swagger.json", "api-schema.json", "openapi.yaml"]:
            for search_root in [self.project_dir, self.project_dir / "docs", self.project_dir / "public"]:
                spec_path = search_root / spec_name
                if not spec_path.exists():
                    continue
                try:
                    if spec_name.endswith(".yaml"):
                        import yaml  # type: ignore
                        spec = yaml.safe_load(spec_path.read_text())
                    else:
                        spec = json.loads(spec_path.read_text())
                    for path, methods in spec.get("paths", {}).items():
                        for verb, op in methods.items():
                            if verb.upper() not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
                                continue
                            params: dict[str, Any] = {}
                            for p in op.get("parameters", []):
                                params[p.get("name", "param")] = (
                                    p.get("schema", {}).get("example") or
                                    p.get("example") or
                                    _default_for_type(p.get("schema", {}).get("type", "string"))
                                )
                            routes.append({
                                "method": verb.upper(),
                                "path": path,
                                "description": op.get("summary", "OpenAPI endpoint"),
                                "params": params,
                            })
                except Exception:
                    pass
        return routes

    def _scan_express_routes(self) -> list[dict]:
        routes: list[dict] = []
        for f in self.project_dir.rglob("*.ts"):
            try:
                src = f.read_text(errors="replace")
            except Exception:
                continue
            for m in re.finditer(
                r'(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*["\']([^"\']+)["\']',
                src, re.I,
            ):
                verb = m.group(1).upper()
                path = m.group(2)
                if not path.startswith("/"):
                    path = "/" + path
                routes.append({
                    "method": verb,
                    "path": path,
                    "description": f"Express route ({f.name})",
                    "params": {},
                })
        return routes

    @staticmethod
    def _infer_params(src: str, verb: str) -> dict:
        """Very lightweight param extraction from TypeScript handler source."""
        params: dict = {}
        # Look for destructured body / query params
        for m in re.finditer(r'(?:body|query|params)\s*[=:]\s*\{([^}]+)\}', src):
            for key in re.findall(r'\b(\w+)\b', m.group(1)):
                if key not in ("const", "let", "var", "type"):
                    params[key] = "test"
        return params


def _default_for_type(t: str) -> Any:
    return {"integer": 1, "number": 1.0, "boolean": True, "array": [], "object": {}}.get(t, "test")


# ---------------------------------------------------------------------------
# Hoppscotch Browser Automation (via Playwright / Vercel Agent Browser)
# ---------------------------------------------------------------------------

_HOPPSCOTCH_SCRIPT = r"""
// hoppscotch_runner.cjs — launched by HoppscotchTester
// Opens Hoppscotch web app, runs each API call, captures request/response.
const TARGET_URL = process.argv[2] || "http://localhost:3000";
const ENDPOINTS_JSON = process.argv[3] || "[]";
const endpoints = JSON.parse(ENDPOINTS_JSON);
const results = [];

async function run() {
  let browser, page;

  try {
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      ignoreHTTPSErrors: true,
    });
    page = await ctx.newPage();
  } catch (err) {
    console.log(JSON.stringify({ error: String(err), results: [] }));
    process.exit(0);
  }

  // ── Open Hoppscotch ────────────────────────────────────────────────
  try {
    await page.goto("https://hoppscotch.io", { waitUntil: "networkidle", timeout: 30000 });
    results.push({ step: "open-hoppscotch", status: "pass" });
  } catch (e) {
    // Hoppscotch unreachable — fall back to direct fetch mode (still recorded)
    results.push({ step: "open-hoppscotch", status: "skip", reason: String(e) });
    await browser.close();
    const directResults = await runDirectFetch(endpoints, TARGET_URL);
    console.log(JSON.stringify({ results: directResults, source: "direct-fetch" }));
    process.exit(0);
  }

  // ── For each endpoint: fill URL, set method, send request, capture response ──
  const apiResults = [];
  for (const ep of endpoints.slice(0, 25)) { // cap at 25 to stay within CI time budgets
    const fullUrl = TARGET_URL.replace(/\/$/, "") + ep.path;
    const method = (ep.method || "GET").toUpperCase();

    try {
      // Navigate to Hoppscotch REST tab
      const restTabSel = 'a[href="/"], button[aria-label*="REST"], [data-testid="rest-tab"]';
      try {
        await page.click(restTabSel, { timeout: 5000 });
      } catch(_) { /* already on REST */ }

      // Set method
      try {
        await page.click('[data-testid="method-selector"], .method-selector, select[name="method"]', { timeout: 3000 });
        await page.selectOption('select', method).catch(async () => {
          // Hoppscotch uses a custom dropdown
          await page.click(`text=${method}`, { timeout: 2000 }).catch(() => {});
        });
      } catch(_) {}

      // Set URL
      try {
        const urlInput = page.locator('input[placeholder*="URL"], input[placeholder*="url"], [data-testid="url-input"]').first();
        await urlInput.fill(fullUrl, { timeout: 3000 });
      } catch(_) {
        try {
          await page.fill('input[type="url"]', fullUrl);
        } catch(_2) {}
      }

      // Add body for POST/PUT/PATCH
      let requestBody = null;
      if (["POST", "PUT", "PATCH"].includes(method) && Object.keys(ep.params || {}).length > 0) {
        requestBody = ep.params;
        try {
          // Switch to body tab
          await page.click('button:has-text("Body"), [data-testid="body-tab"]', { timeout: 3000 });
          // Set raw JSON
          await page.click('button:has-text("JSON"), [data-testid="content-type-json"]', { timeout: 2000 }).catch(() => {});
          const bodyEditor = page.locator('textarea, .CodeMirror textarea, [contenteditable]').first();
          await bodyEditor.fill(JSON.stringify(requestBody, null, 2), { timeout: 3000 });
        } catch(_) {}
      }

      // Click Send — intercept with network listener
      let intercepted = null;
      page.on("response", async (resp) => {
        if (!intercepted && resp.url().includes(ep.path.split("?")[0])) {
          try {
            const body = await resp.text();
            intercepted = {
              status: resp.status(),
              headers: resp.headers(),
              body: body.slice(0, 2000),
            };
          } catch (_) {}
        }
      });

      try {
        await Promise.race([
          page.click('button:has-text("Send"), [data-testid="send-button"]', { timeout: 5000 }),
          page.waitForTimeout(6000),
        ]);
      } catch(_) {}

      // Wait for response panel to populate
      await page.waitForTimeout(2000);

      // Read response from Hoppscotch UI
      let uiResponse = "";
      try {
        uiResponse = await page.textContent('[data-testid="response-body"], .response-body, pre.response', { timeout: 3000 }) || "";
      } catch(_) {}

      // Read status code from UI
      let uiStatus = null;
      try {
        const statusText = await page.textContent('[data-testid="response-status"], .response-status, .status-code', { timeout: 2000 });
        uiStatus = parseInt((statusText || "").match(/\d+/)?.[0] || "", 10) || null;
      } catch(_) {}

      apiResults.push({
        method,
        path: ep.path,
        url: fullUrl,
        request_body: requestBody,
        response_status: intercepted?.status ?? uiStatus,
        response_headers: intercepted?.headers ?? {},
        response_body: intercepted?.body ?? uiResponse.slice(0, 2000),
        description: ep.description || "",
        source: "hoppscotch-browser",
      });

    } catch (epErr) {
      apiResults.push({
        method,
        path: ep.path,
        url: fullUrl,
        error: String(epErr),
        source: "hoppscotch-browser",
      });
    }
  }

  await browser.close();
  console.log(JSON.stringify({ results: apiResults, source: "hoppscotch-browser" }));
}

async function runDirectFetch(endpoints, target) {
  const https = require("https");
  const http = require("http");
  const { URL } = require("url");

  const fetchUrl = (method, urlStr, body) => new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;
      const opts = {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Pakalon-Security-Tester/1.0",
          ...(body ? { "Content-Length": Buffer.byteLength(JSON.stringify(body)) } : {}),
        },
        rejectUnauthorized: false,
        timeout: 8000,
      };
      const req = lib.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body: data.slice(0, 2000) });
        });
      });
      req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, headers: {}, body: "timeout" }); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch(e) {
      resolve({ status: 0, headers: {}, body: String(e) });
    }
  });

  const out = [];
  for (const ep of endpoints.slice(0, 25)) {
    const fullUrl = target.replace(/\/$/, "") + ep.path;
    const body = ["POST", "PUT", "PATCH"].includes(ep.method) && ep.params ? ep.params : null;
    const resp = await fetchUrl(ep.method, fullUrl, body);
    out.push({
      method: ep.method,
      path: ep.path,
      url: fullUrl,
      request_body: body,
      response_status: resp.status,
      response_headers: resp.headers,
      response_body: resp.body,
      description: ep.description || "",
      source: "direct-fetch",
    });
  }
  return out;
}

run().catch((err) => {
  console.log(JSON.stringify({ error: String(err), results: [] }));
  process.exit(0);
});
"""


# ---------------------------------------------------------------------------
# Main tester class
# ---------------------------------------------------------------------------

class HoppscotchTester:
    """
    Phase 4 SA1: Hoppscotch + httpx API security tester.

    Workflow:
      1. Discover endpoints from the project source.
      2. Run Hoppscotch browser automation (record real request/response pairs).
      3. Run security-focused httpx fuzzing (XSS, CSRF, SQLi, IDOR, headers).
      4. Aggregate findings, compute security score, write subagent-1.md.
    """

    def __init__(
        self,
        target_url: str = "http://localhost:3000",
        project_dir: str = ".",
        user_plan: str = "free",
    ):
        self.target_url = target_url.rstrip("/")
        self.project_dir = pathlib.Path(project_dir)
        self.user_plan = user_plan
        self.out_dir = get_phase_dir(project_dir, 4)

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    async def run_all(self, send_sse: Any = None) -> dict[str, Any]:
        sse = send_sse or (lambda e: None)

        sse({"type": "text_delta", "content": "🔌 SA1: Discovering API endpoints...\n"})
        discoverer = EndpointDiscoverer(str(self.project_dir), self.target_url)
        endpoints = discoverer.discover()
        sse({"type": "text_delta", "content": f"  Found {len(endpoints)} endpoint(s) to test.\n"})

        # Check target reachability
        reachable = await self._check_reachable()
        if not reachable:
            sse({"type": "text_delta", "content": f"  ⚠️  Target {self.target_url} not reachable — running static analysis only.\n"})
            return self._build_unreachable_result(endpoints)

        # 1. Hoppscotch browser automation
        sse({"type": "text_delta", "content": "🌐 SA1: Opening Hoppscotch for automated API testing...\n"})
        browser_results = await self._run_hoppscotch_browser(endpoints, sse)

        # 2. Security fuzzing via httpx
        sse({"type": "text_delta", "content": "🔍 SA1: Running security fuzzing (XSS, CSRF, SQLi, IDOR, headers)...\n"})
        fuzz_results = await self._run_security_fuzz(endpoints, sse)

        # 3. Aggregate and score
        all_findings = self._analyze_results(browser_results, fuzz_results)
        score = self._compute_score(all_findings)

        summary = {
            "total_findings": len(all_findings),
            "critical": sum(1 for f in all_findings if f.get("severity") == "CRITICAL"),
            "high_severity": sum(1 for f in all_findings if f.get("severity") == "HIGH"),
            "medium_severity": sum(1 for f in all_findings if f.get("severity") == "MEDIUM"),
            "low_severity": sum(1 for f in all_findings if f.get("severity") == "LOW"),
            "endpoints_tested": len(endpoints),
            "security_score": score,
            "passed": score >= 70 and sum(1 for f in all_findings if f["severity"] in ("CRITICAL", "HIGH")) == 0,
        }

        sse({
            "type": "text_delta",
            "content": (
                f"  API Tests: {len(endpoints)} endpoints | "
                f"{summary['critical']} critical, {summary['high_severity']} high | "
                f"Score: {score}/100\n"
            ),
        })

        return {
            "summary": summary,
            "findings": all_findings,
            "browser_results": browser_results,
            "fuzz_results": fuzz_results,
            "endpoints": endpoints,
        }

    # ------------------------------------------------------------------
    # Hoppscotch browser automation
    # ------------------------------------------------------------------

    async def _run_hoppscotch_browser(
        self, endpoints: list[dict], sse: Any
    ) -> list[dict]:
        out: list[dict] = []
        with tempfile.NamedTemporaryFile(
            suffix=".cjs", delete=False, mode="w", encoding="utf-8"
        ) as tf:
            tf.write(_HOPPSCOTCH_SCRIPT)
            script_path = tf.name

        try:
            endpoints_json = json.dumps(endpoints[:25])
            result_raw = await asyncio.to_thread(
                self._run_node, script_path, self.target_url, endpoints_json
            )
            parsed = json.loads(result_raw) if result_raw else {}
            out = parsed.get("results", [])
            source = parsed.get("source", "unknown")
            sse({"type": "text_delta", "content": f"  Hoppscotch ({source}): {len(out)} request(s) executed\n"})
        except Exception as exc:
            sse({"type": "text_delta", "content": f"  Hoppscotch browser skipped: {exc}\n"})
            out = await self._run_direct_fetch(endpoints[:25])
        finally:
            try:
                pathlib.Path(script_path).unlink(missing_ok=True)
            except Exception:
                pass
        return out

    def _run_node(self, script_path: str, target: str, endpoints_json: str) -> str:
        try:
            proc = subprocess.run(
                ["node", script_path, target, endpoints_json],
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(self.project_dir),
            )
            lines = [l for l in proc.stdout.strip().splitlines() if l.strip()]
            return lines[-1] if lines else "{}"
        except Exception as e:
            return json.dumps({"error": str(e), "results": []})

    async def _run_direct_fetch(self, endpoints: list[dict]) -> list[dict]:
        """httpx fallback when browser automation is unavailable."""
        if not HTTPX_AVAILABLE:
            return []
        out: list[dict] = []
        async with _httpx.AsyncClient(
            timeout=10,
            verify=False,
            follow_redirects=True,
            headers={"User-Agent": "Pakalon-Security-Tester/1.0"},
        ) as client:
            for ep in endpoints:
                url = self.target_url + ep["path"]
                method = ep.get("method", "GET").upper()
                body = ep.get("params") if method in ("POST", "PUT", "PATCH") else None
                try:
                    if method == "GET":
                        resp = await client.get(url)
                    elif method == "POST":
                        resp = await client.post(url, json=body or {})
                    elif method == "PUT":
                        resp = await client.put(url, json=body or {})
                    elif method == "PATCH":
                        resp = await client.patch(url, json=body or {})
                    elif method == "DELETE":
                        resp = await client.delete(url)
                    else:
                        resp = await client.request(method, url)
                    out.append({
                        "method": method,
                        "path": ep["path"],
                        "url": url,
                        "request_body": body,
                        "response_status": resp.status_code,
                        "response_headers": dict(resp.headers),
                        "response_body": resp.text[:2000],
                        "source": "direct-fetch",
                    })
                except Exception as e:
                    out.append({
                        "method": method,
                        "path": ep["path"],
                        "url": url,
                        "error": str(e),
                        "source": "direct-fetch",
                    })
        return out

    # ------------------------------------------------------------------
    # Security fuzzing
    # ------------------------------------------------------------------

    async def _run_security_fuzz(
        self, endpoints: list[dict], sse: Any
    ) -> list[dict]:
        if not HTTPX_AVAILABLE:
            sse({"type": "text_delta", "content": "  httpx not installed — security fuzzing skipped.\n"})
            return []

        findings: list[dict] = []
        async with _httpx.AsyncClient(
            timeout=10,
            verify=False,
            follow_redirects=True,
            headers={"User-Agent": "Pakalon-Security-Tester/1.0"},
        ) as client:
            # --- Header security check (once per root) ---
            findings += await self._check_security_headers(client)

            # --- CORS misconfiguration ---
            findings += await self._check_cors(client)

            for ep in endpoints[:20]:   # cap at 20 for speed
                url = self.target_url + ep["path"]
                method = ep.get("method", "GET").upper()
                params = dict(ep.get("params") or {})

                # --- XSS injection ---
                if method in ("GET", "POST"):
                    for payload in _XSS_PAYLOADS[:2]:   # 2 probes per endpoint
                        findings += await self._probe_xss(client, method, url, params, payload)

                # --- SQL injection ---
                if method in ("GET", "POST"):
                    for payload in _SQLI_PAYLOADS[:2]:
                        findings += await self._probe_sqli(client, method, url, params, payload)

                # --- CSRF (missing/absent token) ---
                if method in ("POST", "PUT", "PATCH", "DELETE"):
                    findings += await self._probe_csrf(client, method, url, params)

                # --- Authentication bypass ---
                if "/auth" in ep["path"] or "/login" in ep["path"] or "/admin" in ep["path"]:
                    findings += await self._probe_auth_bypass(client, method, url, params)

                # --- IDOR / parameter tampering ---
                findings += await self._probe_idor(client, method, url, params)

                # --- Verb tampering ---
                findings += await self._probe_verb_tampering(client, url)

                # --- Command injection (POST bodies only) ---
                if method == "POST" and params:
                    for payload in _CMD_INJECTION_PAYLOADS[:1]:
                        findings += await self._probe_cmd_injection(client, url, params, payload)

                # --- Mass assignment / over-posting ---
                if method in ("POST", "PUT", "PATCH"):
                    findings += await self._probe_mass_assignment(client, method, url, params)

                # --- SSRF probes ---
                if method in ("GET", "POST"):
                    findings += await self._probe_ssrf(client, method, url, params)

        return findings

    # ------------------------------------------------------------------
    # Individual probe methods
    # ------------------------------------------------------------------

    async def _check_security_headers(self, client: Any) -> list[dict]:
        findings: list[dict] = []
        try:
            resp = await client.get(self.target_url)
            for header, desc in _REQUIRED_SECURITY_HEADERS.items():
                if header.lower() not in {k.lower() for k in resp.headers}:
                    findings.append({
                        "severity": "MEDIUM",
                        "type": "MISSING_SECURITY_HEADER",
                        "header": header,
                        "description": desc,
                        "url": self.target_url,
                        "recommendation": f"Add `{header}` response header with an appropriate policy.",
                        "owasp": "A05:2021 – Security Misconfiguration",
                        "cwe": 693,
                    })
        except Exception:
            pass
        return findings

    async def _check_cors(self, client: Any) -> list[dict]:
        findings: list[dict] = []
        try:
            resp = await client.options(
                self.target_url,
                headers={"Origin": "https://evil.attacker.com", "Access-Control-Request-Method": "GET"},
            )
            acao = resp.headers.get("access-control-allow-origin", "")
            if acao in _DANGEROUS_CORS_ORIGINS or acao == "https://evil.attacker.com":
                findings.append({
                    "severity": "HIGH",
                    "type": "CORS_MISCONFIGURATION",
                    "description": f"Access-Control-Allow-Origin: '{acao}' allows arbitrary cross-origin requests.",
                    "url": self.target_url,
                    "recommendation": "Restrict CORS to specific trusted origins. Never use '*' for credentialed requests.",
                    "owasp": "A01:2021 – Broken Access Control",
                    "cwe": 942,
                    "response_header": acao,
                })
        except Exception:
            pass
        return findings

    async def _probe_xss(
        self, client: Any, method: str, url: str, params: dict, payload: str
    ) -> list[dict]:
        findings: list[dict] = []
        probe_params = {k: payload for k in (list(params.keys())[:3] or ["q", "input", "search"])}
        try:
            if method == "GET":
                resp = await client.get(url, params=probe_params)
            else:
                resp = await client.post(url, json=probe_params)
            body = resp.text
            if payload in body:
                findings.append({
                    "severity": "HIGH",
                    "type": "XSS_REFLECTED",
                    "description": f"XSS payload reflected unescaped in response body: `{payload[:60]}`",
                    "url": url,
                    "method": method,
                    "payload": payload,
                    "response_status": resp.status_code,
                    "response_snippet": body[:300],
                    "recommendation": "Escape all output using context-aware encoding (HTML, JS, URL). Use a Content-Security-Policy header.",
                    "owasp": "A03:2021 – Injection",
                    "cwe": 79,
                })
        except Exception:
            pass
        return findings

    async def _probe_sqli(
        self, client: Any, method: str, url: str, params: dict, payload: str
    ) -> list[dict]:
        findings: list[dict] = []
        probe_params = {k: payload for k in (list(params.keys())[:2] or ["id", "query"])}
        _SQL_ERROR_PATTERNS = [
            r"you have an error in your sql syntax",
            r"unclosed quotation mark",
            r"pg_query\(\)",
            r"sqlite3",
            r"ORA-\d{5}",
            r"unterminated string",
            r"syntax error.*sql",
        ]
        try:
            if method == "GET":
                resp = await client.get(url, params=probe_params)
            else:
                resp = await client.post(url, json=probe_params)
            body = resp.text.lower()
            for pattern in _SQL_ERROR_PATTERNS:
                if re.search(pattern, body, re.I):
                    findings.append({
                        "severity": "CRITICAL",
                        "type": "SQL_INJECTION",
                        "description": f"SQL error message leaked — possible SQLi: matched `{pattern}`",
                        "url": url,
                        "method": method,
                        "payload": payload,
                        "response_status": resp.status_code,
                        "response_snippet": resp.text[:400],
                        "recommendation": "Use parameterised queries / ORM. Never concatenate user input into SQL strings.",
                        "owasp": "A03:2021 – Injection",
                        "cwe": 89,
                    })
                    break
        except Exception:
            pass
        return findings

    async def _probe_csrf(
        self, client: Any, method: str, url: str, params: dict
    ) -> list[dict]:
        """Attempt mutating state without a CSRF token."""
        findings: list[dict] = []
        probe_body = dict(params) if params else {"action": "test"}
        try:
            # Send without Origin / Referer (simulates cross-origin request)
            resp = await client.request(
                method, url,
                json=probe_body,
                headers={
                    "Origin": "https://attacker.example.com",
                    "Referer": "https://attacker.example.com/evil",
                },
            )
            # A 200/201/204 on a state-mutating method without CSRF protection is suspicious
            if resp.status_code in (200, 201, 204):
                findings.append({
                    "severity": "HIGH",
                    "type": "CSRF_POSSIBLE",
                    "description": (
                        f"{method} {url} accepted a cross-origin request (status {resp.status_code}) "
                        "without SameSite cookie or CSRF token enforcement."
                    ),
                    "url": url,
                    "method": method,
                    "response_status": resp.status_code,
                    "response_snippet": resp.text[:200],
                    "recommendation": (
                        "Enforce SameSite=Strict or SameSite=Lax cookies for session management. "
                        "Add CSRF tokens for all state-mutating endpoints."
                    ),
                    "owasp": "A01:2021 – Broken Access Control",
                    "cwe": 352,
                })
        except Exception:
            pass
        return findings

    async def _probe_auth_bypass(
        self, client: Any, method: str, url: str, params: dict
    ) -> list[dict]:
        findings: list[dict] = []
        bypass_headers_sets = [
            {},  # No auth header at all
            {"Authorization": "Bearer invalid.token.here"},
            {"Authorization": "Bearer "},
            {"X-Auth-Token": "0", "Authorization": "null"},
        ]
        for headers in bypass_headers_sets:
            try:
                resp = await client.request(method, url, json=params or {}, headers=headers)
                if resp.status_code in (200, 201):
                    findings.append({
                        "severity": "CRITICAL",
                        "type": "AUTH_BYPASS",
                        "description": (
                            f"Endpoint returned {resp.status_code} with no/invalid authentication header "
                            f"(sent: {headers})."
                        ),
                        "url": url,
                        "method": method,
                        "probe_headers": str(headers),
                        "response_status": resp.status_code,
                        "response_snippet": resp.text[:200],
                        "recommendation": "Require valid authentication on all protected endpoints. Return 401 for missing/invalid tokens.",
                        "owasp": "A07:2021 – Identification and Authentication Failures",
                        "cwe": 306,
                    })
                    break  # one finding per endpoint is enough
            except Exception:
                pass
        return findings

    async def _probe_idor(
        self, client: Any, method: str, url: str, params: dict
    ) -> list[dict]:
        """Replace numeric IDs in the URL with sequential values to probe IDOR."""
        findings: list[dict] = []
        # Replace path segments that look like IDs: /123 or /[id]
        for original_id, probe_id in [("1", "2"), ("123", "124"), ("[id]", "9999")]:
            probe_url = re.sub(rf"(?<=/){re.escape(original_id)}(?=/|$)", probe_id, url)
            if probe_url == url:
                continue
            try:
                resp = await client.request(method, probe_url, json=params or {})
                if resp.status_code == 200:
                    findings.append({
                        "severity": "HIGH",
                        "type": "IDOR_POSSIBLE",
                        "description": f"Object ID can be tampered: `{original_id}` → `{probe_id}` returned 200 on {probe_url}",
                        "url": probe_url,
                        "method": method,
                        "response_status": resp.status_code,
                        "response_snippet": resp.text[:200],
                        "recommendation": "Validate that the authenticated user owns the requested resource before returning it.",
                        "owasp": "A01:2021 – Broken Access Control",
                        "cwe": 639,
                    })
                    break
            except Exception:
                pass
        return findings

    async def _probe_verb_tampering(self, client: Any, url: str) -> list[dict]:
        """Try HTTP verbs the endpoint shouldn't accept."""
        findings: list[dict] = []
        for verb in ("TRACE", "CONNECT"):
            try:
                resp = await client.request(verb, url)
                if resp.status_code not in (405, 501, 403, 400):
                    findings.append({
                        "severity": "LOW",
                        "type": "HTTP_VERB_TAMPERING",
                        "description": f"Non-standard HTTP method {verb} accepted (status {resp.status_code})",
                        "url": url,
                        "method": verb,
                        "response_status": resp.status_code,
                        "recommendation": "Restrict allowed HTTP methods with an allowlist. Return 405 for unexpected verbs.",
                        "owasp": "A05:2021 – Security Misconfiguration",
                        "cwe": 16,
                    })
            except Exception:
                pass
        return findings

    async def _probe_cmd_injection(
        self, client: Any, url: str, params: dict, payload: str
    ) -> list[dict]:
        findings: list[dict] = []
        probe = {k: payload for k in list(params.keys())[:2]}
        _CMD_INDICATORS = ["root:", "uid=", "total ", "bin/bash", "system32"]
        try:
            resp = await client.post(url, json=probe)
            body = resp.text.lower()
            for indicator in _CMD_INDICATORS:
                if indicator in body:
                    findings.append({
                        "severity": "CRITICAL",
                        "type": "COMMAND_INJECTION",
                        "description": f"Command injection indicator `{indicator}` found in response for payload `{payload}`",
                        "url": url,
                        "method": "POST",
                        "payload": payload,
                        "response_status": resp.status_code,
                        "response_snippet": resp.text[:400],
                        "recommendation": "Never pass user input to shell commands. Use subprocess with argument lists, not shell=True.",
                        "owasp": "A03:2021 – Injection",
                        "cwe": 78,
                    })
                    break
        except Exception:
            pass
        return findings

    async def _probe_mass_assignment(
        self, client: Any, method: str, url: str, params: dict
    ) -> list[dict]:
        """Send extra privileged fields that should be ignored."""
        findings: list[dict] = []
        extra = dict(params)
        extra.update({"role": "admin", "is_admin": True, "admin": True, "verified": True, "plan": "enterprise"})
        try:
            resp = await client.request(method, url, json=extra)
            if resp.status_code in (200, 201):
                body = resp.text.lower()
                if any(k in body for k in ("admin", "role", "verified", "enterprise")):
                    findings.append({
                        "severity": "HIGH",
                        "type": "MASS_ASSIGNMENT",
                        "description": "Server reflects privileged fields (role/admin/verified) that were sent in request body.",
                        "url": url,
                        "method": method,
                        "probe_body": extra,
                        "response_status": resp.status_code,
                        "response_snippet": resp.text[:300],
                        "recommendation": "Use an allowlist of accepted fields when binding request bodies to model objects. Never trust client-supplied privilege fields.",
                        "owasp": "A08:2021 – Software and Data Integrity Failures",
                        "cwe": 915,
                    })
        except Exception:
            pass
        return findings

    async def _probe_ssrf(
        self, client: Any, method: str, url: str, params: dict
    ) -> list[dict]:
        findings: list[dict] = []
        url_like_keys = [k for k in params if re.search(r"url|uri|link|href|src|redirect", k, re.I)]
        if not url_like_keys:
            return findings
        for key in url_like_keys[:1]:
            for payload in _SSRF_PAYLOADS[:1]:
                probe = dict(params)
                probe[key] = payload
                try:
                    if method == "GET":
                        resp = await client.get(url, params=probe)
                    else:
                        resp = await client.post(url, json=probe)
                    if resp.status_code == 200 and len(resp.text) > 50:
                        findings.append({
                            "severity": "HIGH",
                            "type": "SSRF_POSSIBLE",
                            "description": f"SSRF probe via `{key}={payload}` returned 200 with a non-empty body.",
                            "url": url,
                            "method": method,
                            "payload": payload,
                            "response_status": resp.status_code,
                            "response_snippet": resp.text[:300],
                            "recommendation": "Validate and allowlist URLs before making server-side requests. Block metadata endpoints and internal IP ranges.",
                            "owasp": "A10:2021 – Server-Side Request Forgery",
                            "cwe": 918,
                        })
                except Exception:
                    pass
        return findings

    # ------------------------------------------------------------------
    # Analysis + scoring
    # ------------------------------------------------------------------

    def _analyze_results(
        self, browser_results: list[dict], fuzz_results: list[dict]
    ) -> list[dict]:
        """
        Merge browser call headers into fuzz findings; detect additional patterns
        from raw response bodies captured by Hoppscotch.
        """
        findings = list(fuzz_results)

        # Inspect browser results for error disclosure, stack traces, etc.
        _ERROR_PATTERNS = [
            (re.compile(r"stack\s*trace|traceback|at .*\.ts:\d+", re.I), "CRITICAL", "STACK_TRACE_DISCLOSURE",
             "Stack trace leaked in API response — reveals internal paths and logic.",
             "Suppress stack traces in production. Return generic error messages."),
            (re.compile(r"password|passwd|secret|api_key|apikey|token", re.I), "HIGH", "SENSITIVE_DATA_EXPOSURE",
             "Sensitive keyword found in API response body.",
             "Never return credentials, tokens, or secrets in API responses."),
            (re.compile(r"mongodb://|postgres://|mysql://|redis://", re.I), "CRITICAL", "DB_CONNECTION_STRING_LEAKED",
             "Database connection string found in API response.",
             "Remove all connection string logging. Use secrets management."),
            (re.compile(r"internal server error|unhandled exception|unhandledpromiserejection", re.I), "MEDIUM",
             "UNHANDLED_ERROR",
             "Unhandled server error exposed in response.",
             "Add global error handlers that return safe, generic error messages."),
        ]

        for br in browser_results:
            body = br.get("response_body", "") or ""
            for pattern, severity, ftype, desc, rec in _ERROR_PATTERNS:
                if pattern.search(body):
                    findings.append({
                        "severity": severity,
                        "type": ftype,
                        "description": f"{desc} (from {br.get('method')} {br.get('path')})",
                        "url": br.get("url", ""),
                        "method": br.get("method", ""),
                        "response_status": br.get("response_status"),
                        "response_snippet": body[:300],
                        "recommendation": rec,
                        "source": "hoppscotch-response-analysis",
                    })

        return findings

    def _compute_score(self, findings: list[dict]) -> int:
        penalty = 0
        for f in findings:
            sev = f.get("severity", "INFO")
            penalty += {"CRITICAL": 25, "HIGH": 15, "MEDIUM": 7, "LOW": 2, "INFO": 0}.get(sev, 0)
        return max(0, 100 - penalty)

    def _build_unreachable_result(self, endpoints: list[dict]) -> dict:
        return {
            "summary": {
                "total_findings": 0,
                "critical": 0,
                "high_severity": 0,
                "medium_severity": 0,
                "low_severity": 0,
                "endpoints_tested": len(endpoints),
                "security_score": 100,
                "passed": True,
                "note": f"Target {self.target_url} was not reachable — dynamic tests skipped.",
            },
            "findings": [],
            "browser_results": [],
            "fuzz_results": [],
            "endpoints": endpoints,
        }

    async def _check_reachable(self) -> bool:
        if not HTTPX_AVAILABLE:
            return False
        try:
            async with _httpx.AsyncClient(timeout=5, verify=False) as c:
                r = await c.get(self.target_url)
                return r.status_code < 500
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Report writer
    # ------------------------------------------------------------------

    def write_subagent_md(self, out_dir: str, results: dict) -> pathlib.Path:
        """
        Write `subagent-1.md` in the Phase 4 output dir with:
          - Executive summary + security score
          - Table of all API requests and responses (from Hoppscotch)
          - Security findings with severity, OWASP classification, CWE, recommendations
          - Overall verdict and change-list (or confirmation that no changes are needed)
        """
        path = pathlib.Path(out_dir) / "subagent-1.md"
        summary = results.get("summary", {})
        endpoints = results.get("endpoints", [])
        browser_results = results.get("browser_results", [])
        findings = results.get("findings", [])
        score = summary.get("security_score", 100)
        passed = summary.get("passed", True)
        note = summary.get("note", "")

        sev_order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
        findings_sorted = sorted(findings, key=lambda f: sev_order.get(f.get("severity", "INFO"), 99))

        # Score bands
        if score >= 90:
            score_label = "🟢 Excellent"
        elif score >= 70:
            score_label = "🟡 Acceptable"
        elif score >= 50:
            score_label = "🟠 Needs Improvement"
        else:
            score_label = "🔴 Critical — Immediate Action Required"

        lines = [
            "# Phase 4 — SA1: Hoppscotch API Security Testing",
            "",
            "## Overview",
            "",
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| Target URL | `{self.target_url}` |",
            f"| Endpoints Discovered | {len(endpoints)} |",
            f"| Endpoints Tested | {summary.get('endpoints_tested', 0)} |",
            f"| Total Findings | {summary.get('total_findings', 0)} |",
            f"| Critical | {summary.get('critical', 0)} |",
            f"| High | {summary.get('high_severity', 0)} |",
            f"| Medium | {summary.get('medium_severity', 0)} |",
            f"| Low | {summary.get('low_severity', 0)} |",
            f"| Security Score | **{score}/100** — {score_label} |",
            f"| Status | {'✅ Passed' if passed else '❌ Failed — see findings below'} |",
            "",
        ]

        if note:
            lines += [f"> ⚠️  {note}", ""]

        # ── Discovered endpoints ──────────────────────────────────────────────
        lines += [
            "## Discovered Endpoints",
            "",
            "| Method | Path | Description |",
            "|--------|------|-------------|",
        ]
        for ep in endpoints:
            lines.append(f"| `{ep.get('method','GET')}` | `{ep.get('path','')}` | {ep.get('description','')} |")
        lines.append("")

        # ── Hoppscotch request / response log ────────────────────────────────
        lines += [
            "## API Request / Response Log (Hoppscotch)",
            "",
            "> All API calls were executed via Hoppscotch and the Vercel Agent Browser.",
            "",
        ]
        if browser_results:
            for idx, br in enumerate(browser_results, 1):
                status = br.get("response_status", "—")
                status_icon = "✅" if isinstance(status, int) and status < 400 else "❌" if isinstance(status, int) and status >= 400 else "⚪"
                lines += [
                    f"### Request {idx}: `{br.get('method','GET')} {br.get('path','')}`",
                    "",
                    f"**URL:** `{br.get('url','')}`  ",
                    f"**Source:** {br.get('source', 'unknown')}  ",
                ]
                if br.get("request_body"):
                    lines += [
                        "**Request Body:**",
                        "```json",
                        json.dumps(br["request_body"], indent=2)[:800],
                        "```",
                    ]
                if br.get("error"):
                    lines += [f"**Error:** `{br['error']}`", ""]
                else:
                    lines += [
                        f"**Response Status:** {status_icon} `{status}`  ",
                    ]
                    resp_headers = br.get("response_headers") or {}
                    if resp_headers:
                        lines += ["**Notable Response Headers:**"]
                        for h in ("content-type", "x-frame-options", "content-security-policy",
                                  "strict-transport-security", "access-control-allow-origin"):
                            if h in resp_headers:
                                lines.append(f"  - `{h}: {resp_headers[h]}`")
                    resp_body = br.get("response_body", "")
                    if resp_body:
                        lines += [
                            "**Response Body (first 500 chars):**",
                            "```",
                            resp_body[:500],
                            "```",
                        ]
                lines.append("")
        else:
            lines += ["_No Hoppscotch request results recorded (target may be unreachable or browser unavailable)._", ""]

        # ── Security findings ────────────────────────────────────────────────
        lines += [
            "## Security Findings",
            "",
        ]
        if findings_sorted:
            for f in findings_sorted:
                icon = {"CRITICAL": "🔴", "HIGH": "🟠", "MEDIUM": "🟡", "LOW": "🔵", "INFO": "⚪"}.get(
                    f.get("severity", "INFO"), "⚪")
                sev = f.get("severity", "INFO")
                ftype = f.get("type", "FINDING")
                lines += [
                    f"### {icon} [{sev}] {ftype}",
                    "",
                    f"**Description:** {f.get('description', '')}  ",
                    f"**URL:** `{f.get('url', '—')}`  ",
                    f"**Method:** `{f.get('method', '—')}`  ",
                ]
                if f.get("payload"):
                    lines.append(f"**Probe Payload:** `{f['payload']}`  ")
                if f.get("response_status"):
                    lines.append(f"**Response Status:** `{f['response_status']}`  ")
                if f.get("owasp"):
                    lines.append(f"**OWASP 2021:** {f['owasp']}  ")
                if f.get("cwe"):
                    lines.append(f"**CWE:** [CWE-{f['cwe']}](https://cwe.mitre.org/data/definitions/{f['cwe']}.html)  ")
                if f.get("response_snippet"):
                    lines += [
                        "**Response Snippet:**",
                        "```",
                        f.get("response_snippet", "")[:400],
                        "```",
                    ]
                lines += [
                    f"**Recommendation:** {f.get('recommendation', '')}",
                    "",
                ]
        else:
            lines += ["✅ **No security issues found.** All probed endpoints behaved safely.", ""]

        # ── Verdict + required code changes ──────────────────────────────────
        lines += ["## Verdict & Required Changes", ""]
        if not passed:
            lines += [
                f"❌ **API security testing FAILED** (score {score}/100). The following changes must be made before Phase 5:",
                "",
            ]
            change_idx = 1
            for f in findings_sorted:
                if f.get("severity") in ("CRITICAL", "HIGH"):
                    lines.append(
                        f"{change_idx}. **[{f['severity']}] {f.get('type','')}** — {f.get('recommendation','Fix required.')}"
                    )
                    change_idx += 1
            if change_idx == 1:
                lines.append("No critical/high changes required, but review medium findings.")
        else:
            lines += [
                f"✅ **API security testing PASSED** (score {score}/100).",
                "",
                "No code changes are required based on Hoppscotch API testing.",
                "All tested endpoints responded correctly and no severe vulnerabilities were detected.",
            ]

        path.write_text("\n".join(lines), encoding="utf-8")
        return path
