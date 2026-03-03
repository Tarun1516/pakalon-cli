"""
Pakalon Python Bridge Server
Provides LangGraph agent execution, Mem0 memory, and ChromaDB vector search.
Runs on localhost:7432 (not exposed externally).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import pathlib
import uuid
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Optional heavy deps — gracefully degraded if missing
try:
    from mem0 import Memory  # type: ignore
    _mem0_available = True
except ImportError:
    _mem0_available = False

try:
    import chromadb  # type: ignore
    _chroma_available = True
except ImportError:
    _chroma_available = False

try:
    from langchain_openai import ChatOpenAI  # type: ignore
    from langgraph.graph import StateGraph, END  # type: ignore
    _langgraph_available = True
except ImportError:
    _langgraph_available = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
_memory: Any = None
_chroma_client: Any = None
_chroma_collection: Any = None
_lance_client: Any = None  # T096: LanceDB client for file indexing

# Pipeline session management: session_id -> asyncio.Queue for HIL input
_pipeline_sessions: dict[str, asyncio.Queue] = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _memory, _chroma_client, _chroma_collection, _lance_client

    if _mem0_available:
        try:
            _memory = Memory()
            log.info("Mem0 memory initialized")
        except Exception as e:
            log.warning(f"Mem0 init failed: {e}")

    if _chroma_available:
        try:
            _chroma_client = chromadb.Client()
            _chroma_collection = _chroma_client.get_or_create_collection("pakalon_context")
            log.info("ChromaDB initialized")
        except Exception as e:
            log.warning(f"ChromaDB init failed: {e}")

    # T096: LanceDB for file attachments
    try:
        import sys as _sys, pathlib as _pl
        _root = str(_pl.Path(__file__).resolve().parents[1])
        if _root not in _sys.path:
            _sys.path.insert(0, _root)
        from memory.lance_client import LanceClient  # type: ignore
        _lance_client = LanceClient()
        log.info("LanceDB initialized")
    except Exception as e:
        log.warning(f"LanceDB init failed (optional): {e}")

    # T-CLI-12: Pre-build registry cache in background if stale/missing
    async def _ensure_registry():
        try:
            from agents.phase3.build_registry import build_registry, DEFAULT_OUT, _is_cache_fresh
            if not _is_cache_fresh(DEFAULT_OUT):
                log.info("Registry cache missing or stale — rebuilding in background…")
                count = await build_registry(output=DEFAULT_OUT, force=False, use_bridge=False, concurrency=3)
                log.info("Registry pre-built: %d components", count)
        except Exception as _e:
            log.warning(f"Registry pre-build skipped: {_e}")
    asyncio.create_task(_ensure_registry())

    yield

    log.info("Bridge shutting down")


app = FastAPI(title="Pakalon Bridge", version="0.1.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class BridgeRequest(BaseModel):
    id: str
    type: str
    payload: dict[str, Any]


class BridgeResponse(BaseModel):
    id: str
    success: bool
    data: Any = None
    error: str | None = None


class AgentStep(BaseModel):
    type: str  # thought | tool_call | tool_result | text
    content: str
    tool: str | None = None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "mem0": _mem0_available,
        "chroma": _chroma_available,
        "langgraph": _langgraph_available,
        "lancedb": _lance_client is not None,
    }


# ---------------------------------------------------------------------------
# LanceDB file indexing — T096
# ---------------------------------------------------------------------------

class LanceAddRequest(BaseModel):
    path: str
    user_id: str = "anonymous"


class LanceSearchRequest(BaseModel):
    query: str
    user_id: str = "anonymous"
    limit: int = 5


@app.post("/lance/add")
async def lance_add(req: LanceAddRequest):
    """Index a file (PDF, image, Figma JSON) into LanceDB."""
    if _lance_client is None:
        return {"success": False, "reason": "LanceDB not available"}
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _lance_client.add_file, req.path)
        return {"success": True, "result": result}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/lance/search")
async def lance_search(req: LanceSearchRequest):
    """Semantic search over indexed files in LanceDB."""
    if _lance_client is None:
        return {"success": True, "results": [], "reason": "LanceDB not available"}
    try:
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, _lance_client.search, req.query, req.limit)
        return {"success": True, "results": results}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Agent executor (LangGraph-backed if available, otherwise direct OpenRouter)
# ---------------------------------------------------------------------------
async def _run_agent_langgraph(
    task: str,
    model: str,
    messages: list[dict],
    project_dir: str,
    token: str,
    privacy_mode: bool = False,
) -> dict:
    """
    Run a LangGraph ReAct agent. Falls back to simple completion if unavailable.

    When privacy_mode=True:
    - Skips Mem0 personal data storage
    - Skips external logging / telemetry
    """
    if not _langgraph_available:
        return await _run_agent_simple(task, model, messages, token)

    from langchain_core.messages import HumanMessage, AIMessage, SystemMessage  # type: ignore

    lc_messages = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if role == "system":
            lc_messages.append(SystemMessage(content=content))
        elif role == "user":
            lc_messages.append(HumanMessage(content=content))
        else:
            lc_messages.append(AIMessage(content=content))

    lc_messages.append(HumanMessage(content=task))

    llm = ChatOpenAI(
        model=model,
        openai_api_base="https://openrouter.ai/api/v1",
        openai_api_key=token,
        streaming=False,
    )

    response = await llm.ainvoke(lc_messages)
    text = response.content if hasattr(response, "content") else str(response)

    # Store memory only when privacy mode is off
    if not privacy_mode and _memory and _mem0_available:
        try:
            _memory.add(f"Task: {task}\nResponse: {text[:500]}", user_id="agent", metadata={"project_dir": project_dir})
        except Exception as mem_err:
            log.debug(f"Memory store skipped: {mem_err}")

    return {
        "response": text,
        "steps": [{"type": "text", "content": text}],
        "tokens_used": 0,
        "privacy_mode": privacy_mode,
    }


async def _run_agent_simple(task: str, model: str, messages: list[dict], token: str) -> dict:
    """Simple HTTP call to OpenRouter without LangGraph."""
    import httpx

    or_messages = [*messages, {"role": "user", "content": task}]

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={"model": model, "messages": or_messages},
        )
        res.raise_for_status()
        data = res.json()
        text = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        return {
            "response": text,
            "steps": [{"type": "text", "content": text}],
            "tokens_used": usage.get("total_tokens", 0),
        }


@app.post("/agent/run", response_model=BridgeResponse)
async def agent_run(req: BridgeRequest):
    payload = req.payload
    task = str(payload.get("task", ""))
    model = str(payload.get("model", "openai/gpt-4o-mini"))
    messages = list(payload.get("messages", []))
    project_dir = str(payload.get("project_dir", "."))
    token = str(payload.get("token", ""))
    privacy_mode: bool = bool(payload.get("privacy_mode", False))  # T163

    if not task:
        raise HTTPException(status_code=400, detail="task is required")

    try:
        result = await _run_agent_langgraph(
            task, model, messages, project_dir, token,
            privacy_mode=privacy_mode,
        )
        return BridgeResponse(id=req.id, success=True, data=result)
    except Exception as e:
        log.error(f"Agent run failed: {e}")
        return BridgeResponse(id=req.id, success=False, error=str(e))


# ---------------------------------------------------------------------------
# Phase 3 Auditor Agent
# ---------------------------------------------------------------------------
class AuditorRunRequest(BaseModel):
    agent: str = "phase3_auditor"
    project_dir: str = "."
    is_yolo: bool = False
    max_iterations: int = 3
    session_id: str | None = None
    user_id: str = "anonymous"


@app.post("/agent/auditor")
async def agent_auditor(req: AuditorRunRequest):
    """Run the Phase 3 Auditor agent standalone (not requiring a full phase-3 run)."""
    try:
        from ..agents.phase3.auditor import run_auditor_standalone  # noqa: PLC0415
    except ImportError:
        try:
            import sys as _sys, pathlib as _pl  # noqa: PLC0415
            _root = str(_pl.Path(__file__).resolve().parents[1])
            if _root not in _sys.path:
                _sys.path.insert(0, _root)
            from agents.phase3.auditor import run_auditor_standalone  # noqa: PLC0415
        except ImportError as ie:
            raise HTTPException(status_code=500, detail=f"Auditor import failed: {ie}")

    import asyncio as _asyncio  # noqa: PLC0415
    try:
        result = await run_auditor_standalone(
            project_dir=req.project_dir,
            user_id=req.user_id,
            is_yolo=req.is_yolo,
            send_sse=None,  # bridge doesn't stream SSE for this endpoint
            input_queue=None,  # standalone HIL not supported via REST; use YOLO or bridge SSE
            max_iterations=req.max_iterations,
        )
        return result
    except Exception as e:
        log.error(f"Auditor agent failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Memory search
# ---------------------------------------------------------------------------
@app.post("/memory/search", response_model=BridgeResponse)
async def memory_search(req: BridgeRequest):
    payload = req.payload
    query = str(payload.get("query", ""))
    user_id = str(payload.get("user_id", ""))
    top_k = int(payload.get("top_k", 5))

    if not _memory or not _mem0_available:
        return BridgeResponse(id=req.id, success=True, data={"memories": []})

    try:
        results = _memory.search(query=query, user_id=user_id, limit=top_k)
        memories = [
            {
                "id": r.get("id", str(uuid.uuid4())),
                "text": r.get("memory", ""),
                "score": r.get("score", 0.0),
                "metadata": r.get("metadata", {}),
            }
            for r in (results if isinstance(results, list) else [])
        ]
        return BridgeResponse(id=req.id, success=True, data={"memories": memories})
    except Exception as e:
        log.error(f"Memory search failed: {e}")
        return BridgeResponse(id=req.id, success=False, error=str(e))


# ---------------------------------------------------------------------------
# Memory add
# ---------------------------------------------------------------------------
class AddMemoryRequest(BaseModel):
    user_id: str
    content: str
    metadata: dict[str, Any] = {}
    privacy_mode: bool = False  # T163: skip Mem0 writes when true


@app.post("/memory/add")
async def memory_add(req: AddMemoryRequest):
    # T163: honour privacy_mode — skip write entirely
    if req.privacy_mode:
        return {"success": True, "skipped": True, "reason": "privacy_mode enabled"}
    if not _memory or not _mem0_available:
        return {"success": False, "reason": "mem0 not available"}
    try:
        _memory.add(req.content, user_id=req.user_id, metadata=req.metadata)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Memory key-value store — generic set/get for structured data (agents, config)
# ---------------------------------------------------------------------------
# In-process store; also persisted to ~/.config/pakalon/bridge_kv.json so
# data survives bridge restarts.

_KV_PATH = pathlib.Path.home() / ".config" / "pakalon" / "bridge_kv.json"
_kv_store: dict[str, dict[str, str]] = {}  # user_id → { key: value }


def _load_kv() -> None:
    """Load persisted KV store from disk on startup."""
    global _kv_store
    try:
        if _KV_PATH.exists():
            _kv_store = json.loads(_KV_PATH.read_text())
    except Exception as e:
        log.warning(f"KV store load failed: {e}")


def _save_kv() -> None:
    """Persist KV store to disk."""
    try:
        _KV_PATH.parent.mkdir(parents=True, exist_ok=True)
        _KV_PATH.write_text(json.dumps(_kv_store))
    except Exception as e:
        log.warning(f"KV store save failed: {e}")


# Load on import
_load_kv()


class KVSetRequest(BaseModel):
    user_id: str
    key: str
    value: str  # serialized JSON string


class KVGetRequest(BaseModel):
    user_id: str
    key: str


@app.post("/memory/set")
async def memory_kv_set(req: KVSetRequest):
    """Store a key-value pair for a user (used for agent definitions, settings, etc.)."""
    if req.user_id not in _kv_store:
        _kv_store[req.user_id] = {}
    _kv_store[req.user_id][req.key] = req.value
    _save_kv()
    return {"success": True}


@app.post("/memory/get")
async def memory_kv_get(req: KVGetRequest):
    """Retrieve a key-value pair for a user. Returns null value if not found."""
    value = _kv_store.get(req.user_id, {}).get(req.key, None)
    return {"success": True, "value": value}


# ---------------------------------------------------------------------------
# Firecrawl web scraping — T-CLI-12 (/web command real scrape)
# ---------------------------------------------------------------------------

class ScrapeRequest(BaseModel):
    url: str
    formats: list[str] = ["markdown", "html"]
    privacy_mode: bool = False


@app.post("/scrape")
async def scrape_url(req: ScrapeRequest):
    """
    Scrape a URL using Firecrawl and return markdown + html.
    Falls back to basic httpx GET + BeautifulSoup if Firecrawl unavailable.
    """
    if req.privacy_mode:
        return {"success": False, "skipped": True, "reason": "privacy_mode enabled"}

    # Try Firecrawl SDK first
    try:
        from firecrawl import FirecrawlApp  # type: ignore
        import os
        api_key = os.environ.get("FIRECRAWL_API_KEY", "")
        if not api_key:
            raise ImportError("No FIRECRAWL_API_KEY set")
        fc = FirecrawlApp(api_key=api_key)
        result = fc.scrape_url(req.url, params={"formats": req.formats})
        return {
            "success": True,
            "url": req.url,
            "markdown": result.get("markdown", ""),
            "html": result.get("html", ""),
            "metadata": result.get("metadata", {}),
            "source": "firecrawl",
        }
    except Exception as fc_err:
        log.warning(f"Firecrawl unavailable ({fc_err}), falling back to httpx")

    # Fallback: plain HTTP GET
    try:
        import httpx
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            resp = await client.get(
                req.url,
                headers={"User-Agent": "Pakalon Web Analyzer/1.0"},
            )
            resp.raise_for_status()
            html = resp.text
            # Very basic markdown-ish extraction
            try:
                from bs4 import BeautifulSoup  # type: ignore
                soup = BeautifulSoup(html, "html.parser")
                for tag in soup(["script", "style", "meta", "link"]):
                    tag.decompose()
                markdown = soup.get_text(separator="\n").strip()
            except ImportError:
                import re
                markdown = re.sub(r"<[^>]+>", "", html).strip()
            return {
                "success": True,
                "url": req.url,
                "markdown": markdown[:20_000],
                "html": html[:20_000],
                "metadata": {},
                "source": "httpx_fallback",
            }
    except Exception as http_err:
        log.error(f"Scrape failed for {req.url}: {http_err}")
        return {"success": False, "error": str(http_err), "url": req.url}


# ---------------------------------------------------------------------------
# Web Search endpoint — T-CLI-WEB-SEARCH
# Used by the AI webSearch tool in tools.ts.
# Priority: Firecrawl search → Brave Search API → DuckDuckGo HTML fallback.
# ---------------------------------------------------------------------------

class WebSearchRequest(BaseModel):
    query: str
    max_results: int = 8


@app.post("/web/search")
async def web_search(req: WebSearchRequest):
    """
    Search the web and return ranked results with titles, URLs, and snippets.
    Tries Firecrawl search → Brave Search → DuckDuckGo HTML fallback.
    """
    query = req.query.strip()
    max_results = min(req.max_results, 20)

    # ── Option 1: Firecrawl search API ───────────────────────────────────────
    firecrawl_key = os.environ.get("FIRECRAWL_API_KEY", "")
    if firecrawl_key:
        try:
            from firecrawl import FirecrawlApp  # type: ignore
            fc = FirecrawlApp(api_key=firecrawl_key)
            raw = fc.search(query, params={"limit": max_results})
            results = []
            for item in (raw.get("data") or raw if isinstance(raw, list) else []):
                results.append({
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "snippet": item.get("description", "") or item.get("markdown", "")[:200],
                })
            if results:
                return {"success": True, "query": query, "results": results, "source": "firecrawl"}
        except Exception as fc_err:
            log.warning(f"Firecrawl search failed ({fc_err}), trying Brave Search")

    # ── Option 2: Brave Search API ───────────────────────────────────────────
    brave_key = os.environ.get("BRAVE_API_KEY", "")
    if brave_key:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    params={"q": query, "count": max_results},
                    headers={"Accept": "application/json", "X-Subscription-Token": brave_key},
                )
                resp.raise_for_status()
                data = resp.json()
                results = [
                    {
                        "title": item.get("title", ""),
                        "url": item.get("url", ""),
                        "snippet": item.get("description", ""),
                    }
                    for item in data.get("web", {}).get("results", [])
                ]
                if results:
                    return {"success": True, "query": query, "results": results, "source": "brave"}
        except Exception as brave_err:
            log.warning(f"Brave Search failed ({brave_err}), trying DuckDuckGo fallback")

    # ── Option 3: DuckDuckGo HTML scrape (no key required) ──────────────────
    try:
        import httpx
        from urllib.parse import quote_plus
        encoded = quote_plus(query)
        async with httpx.AsyncClient(
            timeout=15,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        ) as client:
            resp = await client.get(f"https://html.duckduckgo.com/html/?q={encoded}")
            resp.raise_for_status()
            html = resp.text
            try:
                from bs4 import BeautifulSoup  # type: ignore
                soup = BeautifulSoup(html, "html.parser")
                results = []
                for result in soup.select(".result")[:max_results]:
                    title_el = result.select_one(".result__title a")
                    snippet_el = result.select_one(".result__snippet")
                    if not title_el:
                        continue
                    title = title_el.get_text(strip=True)
                    url = title_el.get("href", "")
                    # DuckDuckGo wraps links in a redirect — extract uddg param
                    if "uddg=" in url:
                        from urllib.parse import urlparse, parse_qs, unquote
                        qs = parse_qs(urlparse(url).query)
                        url = unquote(qs.get("uddg", [url])[0])
                    snippet = snippet_el.get_text(strip=True) if snippet_el else ""
                    results.append({"title": title, "url": url, "snippet": snippet})
                if results:
                    return {"success": True, "query": query, "results": results, "source": "duckduckgo"}
            except ImportError:
                # BeautifulSoup not available — basic regex parse
                import re
                urls = re.findall(r'uddg=([^&"]+)', html)
                from urllib.parse import unquote
                results = [{"title": "", "url": unquote(u), "snippet": ""} for u in urls[:max_results]]
                return {"success": True, "query": query, "results": results, "source": "duckduckgo_basic"}
    except Exception as ddg_err:
        log.error(f"DuckDuckGo search failed: {ddg_err}")

    return {"success": False, "error": "All search providers failed", "query": query, "results": []}


# ---------------------------------------------------------------------------
# Pipeline SSE streaming — T-CLI-03, T-CLI-04, T-CLI-11
# ---------------------------------------------------------------------------

class PipelineStartRequest(BaseModel):
    phase: int = 1          # 1–6
    project_dir: str = "."
    user_prompt: str = ""
    user_id: str = "anonymous"
    user_plan: str = "free"  # T-BACK-11: "free" | "pro" for Phase 4 tool gating
    is_yolo: bool = False
    figma_url: str | None = None
    target_url: str = "http://localhost:3000"


class PipelineInputRequest(BaseModel):
    answer: str


@app.post("/pipeline/start", response_model=BridgeResponse)
async def pipeline_start(req: PipelineStartRequest):
    """
    Start a pipeline session (returns session_id).
    Client should then open SSE /pipeline/stream/{session_id}.
    """
    session_id = str(uuid.uuid4())
    input_queue: asyncio.Queue = asyncio.Queue()
    _pipeline_sessions[session_id] = input_queue
    return BridgeResponse(id=session_id, success=True, data={"session_id": session_id})


@app.get("/pipeline/stream/{session_id}")
async def pipeline_stream(
    session_id: str,
    phase: int = 1,
    project_dir: str = ".",
    user_prompt: str = "",
    user_id: str = "anonymous",
    user_plan: str = "free",
    is_yolo: bool = False,
    figma_url: str | None = None,
    target_url: str = "http://localhost:3000",
):
    """
    SSE endpoint that runs the requested pipeline phase and streams events.
    The client connects here, receives SSE text/event-stream, and POSTs
    answers to /pipeline/input/{session_id} for HIL choice_request events.

    Auto-chaining: phases 3→4→5→6 are automatically triggered in the same
    SSE stream to fulfil the "phase 4 auto-trigger from phase 3" requirement.
    """
    # Create or reuse input queue for session
    if session_id not in _pipeline_sessions:
        _pipeline_sessions[session_id] = asyncio.Queue()
    input_queue = _pipeline_sessions[session_id]

    # SSE event queue
    sse_queue: asyncio.Queue = asyncio.Queue()

    # T103: Compute ContextBudget once for this session — shared across all phases
    try:
        from ..agents.phase1.context_budget import ContextBudget  # noqa: PLC0415
        _cb = ContextBudget(total_context=128000, is_new_project=True)
        _context_budget: dict | None = _cb.get_all()
    except Exception:
        _context_budget = None

    def send_sse(event: dict) -> None:
        """Called by Python agent nodes to emit SSE events."""
        sse_queue.put_nowait(event)

    # T-P3-01/02: Store phase 2 results for handoff to phase 3
    _phase2_result: dict = {}

    async def run_single_phase(ph: int) -> dict:
        """Run a single phase and return its result."""
        nonlocal _phase2_result
        if ph == 1:
            from ..agents.phase1.graph import run_phase1
            return await run_phase1(
                user_prompt=user_prompt,
                project_dir=project_dir,
                user_id=user_id,
                is_yolo=is_yolo,
                figma_url=figma_url or None,
                send_sse=send_sse,
                input_queue=input_queue,
            )
        elif ph == 2:
            from ..agents.phase2.graph import run_phase2
            _phase2_result = await run_phase2(
                project_dir=project_dir,
                user_id=user_id,
                is_yolo=is_yolo,
                send_sse=send_sse,
                input_queue=input_queue,
                context_budget=_context_budget,
            )
            return _phase2_result
        elif ph == 3:
            from ..agents.phase3.graph import run_phase3
            return await run_phase3(
                project_dir=project_dir,
                user_id=user_id,
                is_yolo=is_yolo,
                send_sse=send_sse,
                input_queue=input_queue,
                context_budget=_context_budget,
                wireframe_svg=_phase2_result.get("wireframe_svg", ""),  # T-P3-01
                penpot_project_url=_phase2_result.get("penpot_project_url"),  # T-P3-02
            )
        elif ph == 4:
            from ..agents.phase4.graph import run_phase4
            return await run_phase4(
                project_dir=project_dir,
                target_url=target_url,
                user_id=user_id,
                user_plan=user_plan,
                is_yolo=is_yolo,
                send_sse=send_sse,
                input_queue=input_queue,
                context_budget=_context_budget,
            )
        elif ph == 5:
            from ..agents.phase5.graph import run_phase5
            return await run_phase5(
                project_dir=project_dir,
                user_id=user_id,
                is_yolo=is_yolo,
                send_sse=send_sse,
                input_queue=input_queue,
                context_budget=_context_budget,
            )
        elif ph == 6:
            from ..agents.phase6.graph import run_phase6
            return await run_phase6(
                project_dir=project_dir,
                user_id=user_id,
                is_yolo=is_yolo,
                send_sse=send_sse,
                input_queue=input_queue,
                context_budget=_context_budget,
            )
        else:
            send_sse({"type": "error", "message": f"Unknown phase {ph}"})
            return {}

    async def run_phase() -> None:
        """
        Run the requested pipeline phase in the background.
        For phase >= 3 (in YOLO mode), automatically chains 3→4→5→6.
        In HIL mode, phases 1 and 2 run individually; 3→4→5→6 also auto-chain.
        """
        try:
            result = await run_single_phase(phase)

            # T-CLI: Auto-trigger Phase 4→5→6 after Phase 3 completes
            # Also auto-trigger Phase 5→6 after Phase 4 completes
            # And Phase 6 after Phase 5 completes
            skip_phase4 = result.get("skip_phase4", False) if isinstance(result, dict) else False

            if phase == 3:
                if not skip_phase4:
                    send_sse({"type": "text_delta", "content": "\n🔐 Auto-starting Phase 4: Security QA...\n"})
                    await run_single_phase(4)
                else:
                    send_sse({"type": "text_delta", "content": "\n⏭  Phase 4 skipped — starting Phase 5...\n"})

                send_sse({"type": "text_delta", "content": "\n🚀 Auto-starting Phase 5: CI/CD...\n"})
                await run_single_phase(5)

                send_sse({"type": "text_delta", "content": "\n📚 Auto-starting Phase 6: Documentation...\n"})
                await run_single_phase(6)

            elif phase == 4:
                # GAP-P0-01: Check for phase3_retry_request events and loop if needed
                max_retries = 3
                retry_count = 0
                retry_findings = None
                while retry_count < max_retries:
                    # Run Phase 4 and collect any retry requests
                    phase4_result = await run_single_phase(4)
                    retry_findings = phase4_result.get("phase3_findings", []) if isinstance(phase4_result, dict) else []

                    if not retry_findings:
                        break  # No issues found, continue to Phase 5
774#
                    # Run Phase 3 with retry_patch_plan
                    send_sse({
                        "type": "text_delta",
                        "content": f"\n🔄 Running Phase 3 retry {retry_count + 1}/{max_retries} with patch plan...\n"
                    })
                    from ..agents.phase3.graph import run_phase3
                    await run_phase3(
                        project_dir=project_dir,
                        user_id=user_id,
                        is_yolo=is_yolo,
                        send_sse=send_sse,
                        input_queue=input_queue,
                        context_budget=_context_budget,
                        retry_patch_plan={"findings": retry_findings, "retry_count": retry_count + 1},
                    )
790#
                    retry_count += 1
                    send_sse({
                        "type": "text_delta",
                        "content": f"\n✅ Phase 3 retry {retry_count} complete. Re-running Phase 4 to verify...\n"
                    })
796#
                # After all retries (or no retries needed), continue to Phase 5
                send_sse({"type": "text_delta", "content": "\n🚀 Auto-starting Phase 5: CI/CD...\n"})
                await run_single_phase(5)

                send_sse({"type": "text_delta", "content": "\n📚 Auto-starting Phase 6: Documentation...\n"})
                await run_single_phase(6)

            elif phase == 5:
                # Auto-trigger Phase 6 after Phase 5
                send_sse({"type": "text_delta", "content": "\n📚 Auto-starting Phase 6: Documentation...\n"})
                await run_single_phase(6)

        except Exception as exc:
            log.error(f"Pipeline phase {phase} failed: {exc}")
            send_sse({"type": "error", "message": str(exc)})
        finally:
            send_sse({"type": "stream_end"})
            # Cleanup session queue after small delay
            await asyncio.sleep(60)
            _pipeline_sessions.pop(session_id, None)

                # GAP-P0-01: Check for phase3_retry_request events and loop if needed
                max_retries = 3
                retry_count = 0
                retry_findings = None
                while retry_count < max_retries:
                    # Run Phase 4 and collect any retry requests
                    phase4_result = await run_single_phase(4)
                    retry_findings = phase4_result.get("phase3_findings", []) if isinstance(phase4_result, dict) else []

                    if not retry_findings:
                        break  # No issues found, continue to Phase 5
774#
                    # Run Phase 3 with retry_patch_plan
                    send_sse({
                        "type": "text_delta",
                        "content": f"\n🔄 Running Phase 3 retry {retry_count + 1}/{max_retries} with patch plan...\n"
                    })
                    from ..agents.phase3.graph import run_phase3
                    await run_phase3(
                        project_dir=project_dir,
                        user_id=user_id,
                        is_yolo=is_yolo,
                        send_sse=send_sse,
                        input_queue=input_queue,
                        context_budget=_context_budget,
                        retry_patch_plan={"findings": retry_findings, "retry_count": retry_count + 1},
789#                    )
790#
                    retry_count += 1
                    send_sse({
                        "type": "text_delta",
                        "content": f"\n✅ Phase 3 retry {retry_count} complete. Re-running Phase 4 to verify...\n"
                    })
796#
                # After all retries (or no retries needed), continue to Phase 5
                send_sse({"type": "text_delta", "content": "\n🚀 Auto-starting Phase 5: CI/CD...\n"})
                await run_single_phase(5)

                send_sse({"type": "text_delta", "content": "\n📚 Auto-starting Phase 6: Documentation...\n"})
                await run_single_phase(6)

        except Exception as exc:
            log.error(f"Pipeline phase {phase} failed: {exc}")
            send_sse({"type": "error", "message": str(exc)})
        finally:
            send_sse({"type": "stream_end"})
            # Cleanup session queue after small delay
            await asyncio.sleep(60)
            _pipeline_sessions.pop(session_id, None)


            elif phase == 5:
                # Auto-trigger Phase 6 after Phase 5
                send_sse({"type": "text_delta", "content": "\n📚 Auto-starting Phase 6: Documentation...\n"})
                await run_single_phase(6)
                send_sse({"type": "text_delta", "content": "\n🚀 Auto-starting Phase 5: CI/CD...\n"})
                await run_single_phase(5)

                send_sse({"type": "text_delta", "content": "\n📚 Auto-starting Phase 6: Documentation...\n"})
                await run_single_phase(6)
                # T-CLI: Auto-trigger Phase 5→6 after Phase 4 completes
                send_sse({"type": "text_delta", "content": "\n🚀 Auto-starting Phase 5: CI/CD...\n"})
                await run_single_phase(5)

                send_sse({"type": "text_delta", "content": "\n📚 Auto-starting Phase 6: Documentation...\n"})
                await run_single_phase(6)

            elif phase == 5:
                # Auto-trigger Phase 6 after Phase 5
                send_sse({"type": "text_delta", "content": "\n📚 Auto-starting Phase 6: Documentation...\n"})
                await run_single_phase(6)

        except Exception as exc:
            log.error(f"Pipeline phase {phase} failed: {exc}")
            send_sse({"type": "error", "message": str(exc)})
        finally:
            send_sse({"type": "stream_end"})
            # Cleanup session queue after small delay
            await asyncio.sleep(60)
            _pipeline_sessions.pop(session_id, None)

    asyncio.create_task(run_phase())

    async def event_generator():
        while True:
            try:
                event = await asyncio.wait_for(sse_queue.get(), timeout=300.0)
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") == "stream_end":
                    break
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/pipeline/input/{session_id}", response_model=BridgeResponse)
async def pipeline_input(session_id: str, req: PipelineInputRequest):
    """
    Inject user input (HIL choice_response or approval) into the pipeline
    asyncio queue for the given session.
    """
    if session_id not in _pipeline_sessions:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    input_queue = _pipeline_sessions[session_id]
    await input_queue.put(req.answer)
    return BridgeResponse(id=session_id, success=True, data={"queued": req.answer})


# ---------------------------------------------------------------------------
# Penpot wireframe generation — T089, T-CLI-04
# ---------------------------------------------------------------------------

class PenpotGenerateRequest(BaseModel):
    design_spec: dict = {}
    title: str = "Wireframe"
    pages: list[str] = []


@app.post("/penpot/generate_wireframe")
async def penpot_generate_wireframe(req: PenpotGenerateRequest):
    """
    Generate a Penpot wireframe from a design spec.
    T089: POST /penpot/generate_wireframe route.
    T-CLI-04: Calls PenpotTool via live Docker REST API with SVG fallback.
    """
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)

    try:
        from tools.penpot import PenpotTool  # type: ignore
        spec = dict(req.design_spec)
        spec.setdefault("title", req.title)
        if req.pages:
            spec["pages"] = [{"name": p, "sections": []} for p in req.pages]

        tool = PenpotTool()
        svg = tool.create_wireframe(spec)
        penpot_running = tool.is_running()
        return {
            "success": True,
            "svg": svg,
            "penpot_url": "http://localhost:3449" if penpot_running else None,
            "source": "penpot_api" if penpot_running else "svg_fallback",
        }
    except Exception as exc:
        log.error(f"Penpot wireframe generation failed: {exc}")
        return {
            "success": False,
            "error": str(exc),
            "svg": None,
            "penpot_url": None,
        }


# Penpot Live Sync — Bidirectional sync with Penpot designs
# ---------------------------------------------------------------------------

class PenpotSyncRequest(BaseModel):
    api_url: str = "http://localhost:9001/api"
    api_token: str | None = None
    project_id: str | None = None
    local_dir: str = ".pakalon-agents/ai-agents/phase-2/wireframes"
    direction: str = "bidirectional"
    poll_interval: int = 30


class PenpotConfigureRequest(BaseModel):
    api_url: str | None = None
    api_token: str | None = None
    project_id: str | None = None


# In-memory sync client (per-bridge-instance)
_penpot_sync_client = None


@app.get("/penpot/status")
async def penpot_status():
    """Get Penpot connection and sync status."""
    global _penpot_sync_client

    if _penpot_sync_client is None:
        return {
            "connected": False,
            "message": "Penpot sync not initialized",
            "sync_status": {
                "status": "disconnected",
                "last_sync": None,
                "direction": "bidirectional",
                "conflicts_count": 0,
                "local_version": "",
                "remote_version": "",
                "error": "Not initialized",
            },
        }

    try:
        connected, message = await _penpot_sync_client.test_connection()
        status = _penpot_sync_client.get_status()
        files = _penpot_sync_client.get_sync_files()

        return {
            "connected": connected,
            "message": message,
            "sync_status": status,
            "files": files,
        }
    except Exception as exc:
        log.error(f"Penpot status failed: {exc}")
        return {
            "connected": False,
            "message": str(exc),
            "sync_status": {
                "status": "error",
                "last_sync": None,
                "direction": "bidirectional",
                "conflicts_count": 0,
                "local_version": "",
                "remote_version": "",
                "error": str(exc),
            },
        }


@app.post("/penpot/sync/start")
async def penpot_sync_start(req: PenpotSyncRequest):
    """Start Penpot sync."""
    global _penpot_sync_client

    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)

    try:
        from agents.phase2.penpot_sync import PenpotSyncClient, SyncDirection

        direction_map = {
            "import": SyncDirection.IMPORT,
            "export": SyncDirection.EXPORT,
            "bidirectional": SyncDirection.BIDIRECTIONAL,
        }

        _penpot_sync_client = PenpotSyncClient(
            api_url=req.api_url,
            api_token=req.api_token,
            project_id=req.project_id,
            local_dir=req.local_dir,
            poll_interval=req.poll_interval,
        )

        direction = direction_map.get(req.direction, SyncDirection.BIDIRECTIONAL)
        await _penpot_sync_client.start_sync(direction)

        return {
            "status": "started",
            "direction": req.direction,
        }
    except Exception as exc:
        log.error(f"Penpot sync start failed: {exc}")
        return {
            "status": "error",
            "error": str(exc),
        }


@app.post("/penpot/sync/stop")
async def penpot_sync_stop():
    """Stop Penpot sync."""
    global _penpot_sync_client

    if _penpot_sync_client:
        await _penpot_sync_client.stop_sync()
        await _penpot_sync_client.close()
        _penpot_sync_client = None

    return {"status": "stopped"}


@app.post("/penpot/import")
async def penpot_import():
    """Import designs from Penpot."""
    global _penpot_sync_client

    if _penpot_sync_client is None:
        return {"status": "error", "error": "Sync not initialized"}

    try:
        await _penpot_sync_client._import_from_penpot()
        files = _penpot_sync_client.get_sync_files()

        return {
            "status": "imported",
            "files": files,
        }
    except Exception as exc:
        log.error(f"Penpot import failed: {exc}")
        return {"status": "error", "error": str(exc)}


@app.post("/penpot/export")
async def penpot_export():
    """Export designs to Penpot."""
    global _penpot_sync_client

    if _penpot_sync_client is None:
        return {"status": "error", "error": "Sync not initialized"}

    try:
        await _penpot_sync_client._export_to_penpot()
        files = _penpot_sync_client.get_sync_files()

        return {
            "status": "exported",
            "files": files,
        }
    except Exception as exc:
        log.error(f"Penpot export failed: {exc}")
        return {"status": "error", "error": str(exc)}


@app.post("/penpot/configure")
async def penpot_configure(req: PenpotConfigureRequest):
    """Configure Penpot connection."""
    global _penpot_sync_client

    # Store configuration for future sync sessions
    if req.api_token:
        os.environ["PENPOT_API_TOKEN"] = req.api_token
    if req.project_id:
        os.environ["PENPOT_PROJECT_ID"] = req.project_id

    # Test connection with new config
    if _penpot_sync_client:
        connected, message = await _penpot_sync_client.test_connection()
        return {
            "status": "configured",
            "message": message,
            "connected": connected,
        }

    return {
        "status": "configured",
        "message": "Configuration saved. Start sync to connect.",
        "connected": False,
    }


# Penpot Live Sync — Live bidirectional sync with Penpot
# ---------------------------------------------------------------------------

class PenpotSyncRequest(BaseModel):
    api_url: str = "http://localhost:9001/api"
    api_token: str = ""
    project_id: str = ""
    direction: str = "bidirectional"
    poll_interval: int = 30


class PenpotConfigureRequest(BaseModel):
    api_url: str | None = None
    api_token: str | None = None
    project_id: str | None = None


# In-memory sync state (per-process)
_penpot_sync_client = None


@app.get("/penpot/status")
async def penpot_status():
    """Get Penpot sync status."""
    global _penpot_sync_client
    if _penpot_sync_client is None:
        return {
            "connected": False,
            "message": "Penpot sync not initialized",
            "sync_status": {
                "status": "disconnected",
                "last_sync": None,
                "direction": "bidirectional",
                "conflicts_count": 0,
                "local_version": "",
                "remote_version": "",
                "error": "Not configured",
            },
        }

    try:
        status = _penpot_sync_client.get_status()
        connected, message = await _penpot_sync_client.test_connection()
        files = _penpot_sync_client.get_sync_files() if connected else []
        return {
            "connected": connected,
            "message": message,
            "sync_status": status,
            "files": files,
        }
    except Exception as exc:
        log.error(f"Penpot status failed: {exc}")
        return {
            "connected": False,
            "message": str(exc),
            "sync_status": {
                "status": "error",
                "last_sync": None,
                "direction": "bidirectional",
                "conflicts_count": 0,
                "local_version": "",
                "remote_version": "",
                "error": str(exc),
            },
        }


@app.post("/penpot/configure")
async def penpot_configure(req: PenpotConfigureRequest):
    """Configure Penpot connection."""
    global _penpot_sync_client
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)

    try:
        from agents.phase2.penpot_sync import PenpotSyncClient

        api_url = req.api_url or os.environ.get("PENPOT_API_URL", "http://localhost:9001/api")
        api_token = req.api_token or os.environ.get("PENPOT_API_TOKEN", "")
        project_id = req.project_id or os.environ.get("PENPOT_PROJECT_ID", "")

        _penpot_sync_client = PenpotSyncClient(
            api_url=api_url,
            api_token=api_token,
            project_id=project_id,
        )

        connected, message = await _penpot_sync_client.test_connection()
        return {
            "status": "configured",
            "message": message,
            "connected": connected,
        }
    except Exception as exc:
        log.error(f"Penpot configure failed: {exc}")
        return {
            "status": "error",
            "message": str(exc),
            "connected": False,
        }


@app.post("/penpot/sync/start")
async def penpot_sync_start(req: PenpotSyncRequest):
    """Start Penpot sync."""
    global _penpot_sync_client

    if _penpot_sync_client is None:
        # Auto-configure first
        await penpot_configure(PenpotConfigureRequest())

    if _penpot_sync_client is None:
        return {"status": "error", "message": "Penpot not configured"}

    try:
        from agents.phase2.penpot_sync import SyncDirection

        direction_map = {
            "import": SyncDirection.IMPORT,
            "export": SyncDirection.EXPORT,
            "bidirectional": SyncDirection.BIDIRECTIONAL,
        }
        direction = direction_map.get(req.direction, SyncDirection.BIDIRECTIONAL)

        await _penpot_sync_client.start_sync(direction)
        return {
            "status": "started",
            "direction": req.direction,
        }
    except Exception as exc:
        log.error(f"Penpot sync start failed: {exc}")
        return {"status": "error", "message": str(exc)}


@app.post("/penpot/sync/stop")
async def penpot_sync_stop():
    """Stop Penpot sync."""
    global _penpot_sync_client

    if _penpot_sync_client is None:
        return {"status": "stopped"}

    try:
        await _penpot_sync_client.stop_sync()
        return {"status": "stopped"}
    except Exception as exc:
        log.error(f"Penpot sync stop failed: {exc}")
        return {"status": "error", "message": str(exc)}


@app.post("/penpot/import")
async def penpot_import():
    """Import designs from Penpot."""
    global _penpot_sync_client

    if _penpot_sync_client is None:
        return {"status": "error", "message": "Penpot not configured"}

    try:
        await _penpot_sync_client._import_from_penpot()
        return {
            "status": "imported",
            "files": _penpot_sync_client.get_sync_files(),
        }
    except Exception as exc:
        log.error(f"Penpot import failed: {exc}")
        return {"status": "error", "message": str(exc)}


@app.post("/penpot/export")
async def penpot_export():
    """Export designs to Penpot."""
    global _penpot_sync_client

    if _penpot_sync_client is None:
        return {"status": "error", "message": "Penpot not configured"}

    try:
        await _penpot_sync_client._export_to_penpot()
        return {
            "status": "exported",
            "files": _penpot_sync_client.get_sync_files(),
        }
    except Exception as exc:
        log.error(f"Penpot export failed: {exc}")
        return {"status": "error", "message": str(exc)}


# ---------------------------------------------------------------------------
# Image and Video Analysis — T100
# ---------------------------------------------------------------------------

class ImageAnalysisRequest(BaseModel):
    path: str

class VideoAnalysisRequest(BaseModel):
    path: str
    fps: int = 1

@app.post("/tools/analyze_image")
async def analyze_image(req: ImageAnalysisRequest):
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    try:
        from tools.image_video import ImageAnalysisTool
        tool = ImageAnalysisTool()
        result = tool.analyze(req.path)
        return {"success": True, "data": result}
    except Exception as exc:
        log.error(f"Image analysis failed: {exc}")
        return {"success": False, "error": str(exc)}

@app.post("/tools/analyze_video")
async def analyze_video(req: VideoAnalysisRequest):
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    try:
        from tools.image_video import VideoAnalysisTool
        tool = VideoAnalysisTool()
        result = tool.extract_and_analyze(req.path, fps=req.fps)
        return {"success": True, "data": result}
    except Exception as exc:
        log.error(f"Video analysis failed: {exc}")
        return {"success": False, "error": str(exc)}

@app.post("/tools/analyze_video")
async def analyze_video(req: VideoAnalysisRequest):
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    try:
        from tools.image_video import VideoAnalysisTool
        tool = VideoAnalysisTool()
        result = tool.extract_and_analyze(req.path, fps=req.fps)
        return {"success": True, "data": result}
    except Exception as exc:
        log.error(f"Video analysis failed: {exc}")
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Image & Video Generation (Pro-only) — T-CLI-P8
# ---------------------------------------------------------------------------

class ImageGenerateRequest(BaseModel):
    prompt: str
    output_path: str | None = None
    model: str = "flux"
    width: int = 1024
    height: int = 1024
    steps: int = 28
    guidance: float = 3.5
    user_plan: str = "free"

class VideoGenerateRequest(BaseModel):
    prompt: str
    image_path: str | None = None
    output_path: str | None = None
    model: str = "minimax"
    duration: int = 5
    user_plan: str = "free"

@app.post("/tools/generate_image")
async def generate_image(req: ImageGenerateRequest):
    """Pro-only: generate an image from a text prompt using Flux/DALL-E/Stability."""
    if req.user_plan != "pro":
        return {
            "success": False,
            "error": "Image generation is a Pro-only feature. Upgrade at pakalon.com/pricing.",
            "plan_blocked": True,
        }
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    try:
        from tools.image_video import ImageGenerationTool
        tool = ImageGenerationTool()
        result = tool.generate(
            prompt=req.prompt,
            output_path=req.output_path,
            model=req.model,
            width=req.width,
            height=req.height,
            steps=req.steps,
            guidance=req.guidance,
        )
        return {"success": result.get("success", False), "data": result}
    except Exception as exc:
        log.error(f"Image generation failed: {exc}")
        return {"success": False, "error": str(exc)}

@app.post("/tools/generate_video")
async def generate_video(req: VideoGenerateRequest):
    """Pro-only: generate a video from a text prompt using Runway/Replicate/fal.ai."""
    if req.user_plan != "pro":
        return {
            "success": False,
            "error": "Video generation is a Pro-only feature. Upgrade at pakalon.com/pricing.",
            "plan_blocked": True,
        }
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    try:
        from tools.image_video import VideoGenerationTool
        tool = VideoGenerationTool()
        result = tool.generate(
            prompt=req.prompt,
            image_path=req.image_path,
            output_path=req.output_path,
            model=req.model,
            duration=req.duration,
        )
        return {"success": result.get("success", False), "data": result}
    except Exception as exc:
        log.error(f"Video generation failed: {exc}")
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# T-CLI-P14: Cloud storage endpoints (MinIO/S3 + Cloudinary)
# ---------------------------------------------------------------------------

class StorageUploadRequest(BaseModel):
    local_path: str
    remote_key: str | None = None
    provider: str | None = None   # "minio" | "cloudinary"
    public: bool = True
    user_plan: str = "free"


class StorageDownloadRequest(BaseModel):
    remote_key: str
    local_path: str | None = None
    provider: str | None = None
    user_plan: str = "free"


class StorageDeleteRequest(BaseModel):
    remote_key: str
    provider: str | None = None
    user_plan: str = "free"


class StorageListRequest(BaseModel):
    prefix: str = ""
    provider: str | None = None
    user_plan: str = "free"


def _storage_tool():
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    from tools.storage import StorageTool
    return StorageTool()


@app.post("/tools/storage/upload")
async def storage_upload(req: StorageUploadRequest):
    """Upload a file to MinIO/S3 or Cloudinary. Pro-only."""
    if req.user_plan != "pro":
        return {"success": False, "error": "Cloud storage is a Pro-only feature.", "plan_blocked": True}
    try:
        result = _storage_tool().upload(req.local_path, req.remote_key, req.provider, req.public)
        return result
    except Exception as exc:
        log.error(f"Storage upload failed: {exc}")
        return {"success": False, "error": str(exc)}


@app.post("/tools/storage/download")
async def storage_download(req: StorageDownloadRequest):
    """Download a file from MinIO/S3 or Cloudinary. Pro-only."""
    if req.user_plan != "pro":
        return {"success": False, "error": "Cloud storage is a Pro-only feature.", "plan_blocked": True}
    try:
        result = _storage_tool().download(req.remote_key, req.local_path, req.provider)
        return result
    except Exception as exc:
        log.error(f"Storage download failed: {exc}")
        return {"success": False, "error": str(exc)}


@app.post("/tools/storage/delete")
async def storage_delete(req: StorageDeleteRequest):
    """Delete a file from cloud storage. Pro-only."""
    if req.user_plan != "pro":
        return {"success": False, "error": "Cloud storage is a Pro-only feature.", "plan_blocked": True}
    try:
        result = _storage_tool().delete(req.remote_key, req.provider)
        return result
    except Exception as exc:
        log.error(f"Storage delete failed: {exc}")
        return {"success": False, "error": str(exc)}


@app.post("/tools/storage/list")
async def storage_list(req: StorageListRequest):
    """List files in cloud storage. Pro-only."""
    if req.user_plan != "pro":
        return {"success": False, "files": [], "error": "Cloud storage is a Pro-only feature.", "plan_blocked": True}
    try:
        result = _storage_tool().list_files(req.prefix, req.provider)
        return result
    except Exception as exc:
        log.error(f"Storage list failed: {exc}")
        return {"success": False, "files": [], "error": str(exc)}


# ---------------------------------------------------------------------------
# LSP (Language Server Protocol) — T-CLI-LSP
# ---------------------------------------------------------------------------

class LspRequest(BaseModel):
    file_path: str
    line: int = 0
    character: int = 0
    workspace_dir: str = ""


class LspRenameRequest(BaseModel):
    file_path: str
    line: int = 0
    character: int = 0
    new_name: str
    workspace_dir: str = ""


class LspSymbolsRequest(BaseModel):
    query: str = ""
    workspace_dir: str = ""
    language: str | None = None


class LspStatusRequest(BaseModel):
    workspace_dir: str = ""


def _lsp_module():
    import sys as _sys
    import pathlib as _pl
    _root = str(_pl.Path(__file__).resolve().parents[1])
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    from agents.shared.lsp import (
        lsp_go_to_definition, lsp_find_references, lsp_hover,
        lsp_completion, lsp_rename, lsp_diagnostics,
        lsp_workspace_symbols, lsp_status,
    )
    return {
        "go_to_definition": lsp_go_to_definition,
        "find_references": lsp_find_references,
        "hover": lsp_hover,
        "completion": lsp_completion,
        "rename": lsp_rename,
        "diagnostics": lsp_diagnostics,
        "workspace_symbols": lsp_workspace_symbols,
        "status": lsp_status,
    }


@app.post("/lsp/definition")
async def lsp_definition(req: LspRequest):
    """Go-to-definition via LSP language server."""
    try:
        lsp = _lsp_module()
        result = await asyncio.to_thread(
            lsp["go_to_definition"], req.file_path, req.line, req.character, req.workspace_dir or os.getcwd()
        )
        return {"success": True, **result}
    except Exception as exc:
        return {"success": False, "error": str(exc), "locations": []}


@app.post("/lsp/references")
async def lsp_references(req: LspRequest):
    """Find all references via LSP language server."""
    try:
        lsp = _lsp_module()
        result = await asyncio.to_thread(
            lsp["find_references"], req.file_path, req.line, req.character, req.workspace_dir or os.getcwd()
        )
        return {"success": True, **result}
    except Exception as exc:
        return {"success": False, "error": str(exc), "references": []}


@app.post("/lsp/hover")
async def lsp_hover_endpoint(req: LspRequest):
    """Hover documentation via LSP language server."""
    try:
        lsp = _lsp_module()
        result = await asyncio.to_thread(
            lsp["hover"], req.file_path, req.line, req.character, req.workspace_dir or os.getcwd()
        )
        return {"success": True, **result}
    except Exception as exc:
        return {"success": False, "error": str(exc), "hover": ""}


@app.post("/lsp/completion")
async def lsp_completion_endpoint(req: LspRequest):
    """Code completion via LSP language server."""
    try:
        lsp = _lsp_module()
        result = await asyncio.to_thread(
            lsp["completion"], req.file_path, req.line, req.character, req.workspace_dir or os.getcwd()
        )
        return {"success": True, **result}
    except Exception as exc:
        return {"success": False, "error": str(exc), "items": []}


@app.post("/lsp/rename")
async def lsp_rename_endpoint(req: LspRenameRequest):
    """Rename symbol via LSP language server."""
    try:
        lsp = _lsp_module()
        result = await asyncio.to_thread(
            lsp["rename"], req.file_path, req.line, req.character, req.new_name, req.workspace_dir or os.getcwd()
        )
        return {"success": True, **result}
    except Exception as exc:
        return {"success": False, "error": str(exc), "workspace_edit": {}}


@app.post("/lsp/diagnostics")
async def lsp_diagnostics_endpoint(req: LspRequest):
    """Get LSP diagnostics (errors/warnings) for a file."""
    try:
        lsp = _lsp_module()
        result = await asyncio.to_thread(
            lsp["diagnostics"], req.file_path, req.workspace_dir or os.getcwd()
        )
        return {"success": True, **result}
    except Exception as exc:
        return {"success": False, "error": str(exc), "diagnostics": []}


@app.post("/lsp/symbols")
async def lsp_symbols_endpoint(req: LspSymbolsRequest):
    """Search workspace symbols via LSP."""
    try:
        lsp = _lsp_module()
        result = await asyncio.to_thread(
            lsp["workspace_symbols"], req.query, req.workspace_dir or os.getcwd(), req.language
        )
        return {"success": True, **result}
    except Exception as exc:
        return {"success": False, "error": str(exc), "symbols": []}


@app.post("/lsp/status")
async def lsp_status_endpoint(req: LspStatusRequest):
    """Return LSP server status for all supported languages."""
    try:
        lsp = _lsp_module()
        result = await asyncio.to_thread(lsp["status"], req.workspace_dir or os.getcwd())
        return {"success": True, **result}
    except Exception as exc:
        return {"success": False, "error": str(exc), "servers": []}


# ---------------------------------------------------------------------------
# P1: Context summarization endpoint (used by /compact and auto-compaction)
# ---------------------------------------------------------------------------

class SummarizeRequest(BaseModel):
    text: str
    model_id: str | None = None
    max_output_tokens: int = 512


@app.post("/agent/summarize")
async def agent_summarize(req: SummarizeRequest):
    """
    Summarize a block of conversation history for context compaction.
    Used by the CLI /compact command and auto-compaction (P1).
    """
    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        # Fallback: return first 2000 chars if no LLM available
        return {"summary": req.text[:2000], "method": "truncation"}

    try:
        if _langgraph_available:
            model_id = req.model_id or "openai/gpt-4o-mini"
            llm = ChatOpenAI(
                model=model_id,
                openai_api_key=api_key,
                openai_api_base="https://openrouter.ai/api/v1",
                max_tokens=req.max_output_tokens,
            )
            response = await asyncio.to_thread(
                llm.invoke,
                f"Summarise this conversation history concisely, preserving all decisions, code changes, file paths, and key facts. Output plain text only:\n\n{req.text[:12000]}"
            )
            summary = response.content if hasattr(response, "content") else str(response)
            return {"summary": summary, "method": "llm"}
        else:
            return {"summary": req.text[:2000], "method": "truncation"}
    except Exception as exc:
        log.warning(f"Summarize failed: {exc}")
        return {"summary": req.text[:2000], "method": "truncation", "error": str(exc)}


# ---------------------------------------------------------------------------
# P7: AI conflict resolution endpoint
# ---------------------------------------------------------------------------

class ConflictSection(BaseModel):
    lineStart: int
    ours: str
    theirs: str
    ancestor: str | None = None


class ResolveConflictRequest(BaseModel):
    file_path: str
    content: str
    sections: list[ConflictSection]
    model_id: str | None = None


@app.post("/agent/resolve-conflict")
async def agent_resolve_conflict(req: ResolveConflictRequest):
    """
    Use AI to intelligently merge conflict sections in a file (P7).
    Returns the resolved file content with conflicts removed.
    """
    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key or not _langgraph_available:
        return {"success": False, "error": "No LLM available for conflict resolution. Use 'ours' or 'theirs' strategy."}

    try:
        model_id = req.model_id or "openai/gpt-4o-mini"
        llm = ChatOpenAI(
            model=model_id,
            openai_api_key=api_key,
            openai_api_base="https://openrouter.ai/api/v1",
            max_tokens=8192,
        )

        # Build a prompt showing all conflict sections
        sections_text = "\n\n".join(
            f"--- CONFLICT {i+1} (line {s.lineStart}) ---\n"
            f"<<<< OURS:\n{s.ours}\n"
            f"==== THEIRS:\n{s.theirs}"
            for i, s in enumerate(req.sections)
        )

        prompt = (
            f"You are merging a file with {len(req.sections)} merge conflict(s).\n\n"
            f"File path: {req.file_path}\n\n"
            f"Conflict sections:\n{sections_text}\n\n"
            f"Here is the full file with conflict markers:\n\n{req.content[:16000]}\n\n"
            "Produce the complete resolved file with ALL conflict markers removed. "
            "Intelligently merge 'ours' and 'theirs' changes where both are needed. "
            "If one side is clearly better, prefer it. "
            "Output ONLY the resolved file content, no explanations.\n\n"
            "Then on a new line after the content, add: EXPLANATION: <one sentence explaining your choices>"
        )

        response = await asyncio.to_thread(llm.invoke, prompt)
        text = response.content if hasattr(response, "content") else str(response)

        # Split out explanation if present
        explanation = None
        resolved_content = text
        if "\nEXPLANATION:" in text:
            parts = text.rsplit("\nEXPLANATION:", 1)
            resolved_content = parts[0].strip()
            explanation = parts[1].strip()

        # Sanity check: ensure no conflict markers remain
        if "<<<<<<" in resolved_content:
            return {"success": False, "error": "AI failed to remove all conflict markers. Try 'ours' or 'theirs' strategy."}

        return {
            "success": True,
            "resolved_content": resolved_content,
            "explanation": explanation,
        }
    except Exception as exc:
        log.error(f"Resolve conflict failed: {exc}")
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# P9: Programmatic tool calling / batch orchestration endpoint
# ---------------------------------------------------------------------------

class OrchestrateTool(BaseModel):
    tool_name: str
    params: dict[str, Any]


class OrchestrateRequest(BaseModel):
    tools: list[OrchestrateTool]
    parallel: bool = False
    model_id: str | None = None
    context: str | None = None


@app.post("/agent/orchestrate")
async def agent_orchestrate(req: OrchestrateRequest):
    """
    P9: Batch/parallel tool orchestration.
    Accepts a list of tool-call descriptors and executes them in order (or in parallel).
    Returns results for each tool call.
    """
    import importlib
    import inspect

    results = []

    async def run_one(tool_call: OrchestrateTool) -> dict:
        tool_name = tool_call.tool_name
        params = tool_call.params
        try:
            # Try to find in bridge tools module first
            bridge_tools = None
            try:
                bridge_tools = importlib.import_module("bridge.tools")
            except ImportError:
                pass

            if bridge_tools and hasattr(bridge_tools, tool_name):
                fn = getattr(bridge_tools, tool_name)
                if inspect.iscoroutinefunction(fn):
                    result = await fn(**params)
                else:
                    result = await asyncio.to_thread(fn, **params)
                return {"tool": tool_name, "success": True, "result": result}
            else:
                return {"tool": tool_name, "success": False, "error": f"Tool '{tool_name}' not found"}
        except Exception as exc:
            return {"tool": tool_name, "success": False, "error": str(exc)}

    if req.parallel:
        tasks = [run_one(t) for t in req.tools]
        results = list(await asyncio.gather(*tasks))
    else:
        for tool_call in req.tools:
            result = await run_one(tool_call)
            results.append(result)

    succeeded = sum(1 for r in results if r.get("success"))
    return {
        "success": True,
        "results": results,
        "succeeded": succeeded,
        "failed": len(results) - succeeded,
    }


# ---------------------------------------------------------------------------
# P3: Browser preview endpoint (Phase 2 — open generated design in browser)
# ---------------------------------------------------------------------------

class BrowserPreviewRequest(BaseModel):
    path: str | None = None
    url: str | None = None


@app.post("/tools/open-browser")
async def open_browser_preview(req: BrowserPreviewRequest):
    """
    P3: Open a file path or URL in the system's default browser.
    Used to preview Phase 2 generated designs / SVGs.
    """
    import platform
    import subprocess

    target = req.url or req.path
    if not target:
        return {"success": False, "error": "Provide 'path' or 'url'"}

    # If it's a local path, convert to file:// URL
    if req.path and not req.path.startswith("http"):
        target = f"file://{os.path.abspath(req.path)}"

    try:
        system = platform.system()
        if system == "Darwin":
            subprocess.Popen(["open", target])
        elif system == "Linux":
            subprocess.Popen(["xdg-open", target])
        elif system == "Windows":
            subprocess.Popen(["cmd", "/c", "start", "", target], shell=False)
        else:
            return {"success": False, "error": f"Unsupported platform: {system}"}

        return {"success": True, "opened": target, "platform": system}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Multi-Environment CI/CD — Phase 5 Enhancement
# ---------------------------------------------------------------------------

class CICDDeployRequest(BaseModel):
    env: str
    commit_sha: str
    branch: str | None = None
    deployed_by: str = "cli"


class CICDPromoteRequest(BaseModel):
    from_env: str
    to_env: str
    promoted_by: str = "cli"


class CICDRollbackRequest(BaseModel):
    env: str
    reason: str
    deployment_id: str | None = None
    rolled_back_by: str = "cli"


class CICDConfigureRequest(BaseModel):
    env: str
    url: str | None = None
    branch: str | None = None
    auto_promote: bool | None = None


# In-memory CICD instance
_cicd_client = None


def _get_cicd():
    global _cicd_client
    if _cicd_client is None:
        import sys as _sys
        import pathlib as _pl
        _root = str(_pl.Path(__file__).resolve().parents[1])
        if _root not in _sys.path:
            _sys.path.insert(0, _root)
        from agents.phase5.multi_env_cicd import create_cicd
        _cicd_client = create_cicd()
    return _cicd_client


@app.get("/cicd/status")
async def cicd_status(env: str | None = None):
    """Get CI/CD status for all environments or a specific environment."""
    try:
        cicd = _get_cicd()
        if env:
            return cicd.get_status(env)
        return cicd.get_all_status()
    except Exception as exc:
        log.error(f"CI/CD status failed: {exc}")
        return {"error": str(exc)}


@app.post("/cicd/deploy")
async def cicd_deploy(req: CICDDeployRequest):
    """Deploy to an environment."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        environment = Environment(req.env)
        deployment = await cicd.deploy(
            env=environment,
            commit_sha=req.commit_sha,
            branch=req.branch,
            deployed_by=req.deployed_by,
        )
        return {
            "id": deployment.id,
            "environment": deployment.environment,
            "status": deployment.status.value,
            "commit_sha": deployment.commit_sha,
            "url": deployment.url,
        }
    except Exception as exc:
        log.error(f"CI/CD deploy failed: {exc}")
        return {"error": str(exc)}


@app.post("/cicd/promote")
async def cicd_promote(req: CICDPromoteRequest):
    """Promote from one environment to another."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        from_env = Environment(req.from_env)
        to_env = Environment(req.to_env)
        deployment = await cicd.promote(
            from_env=from_env,
            to_env=to_env,
            promoted_by=req.promoted_by,
        )
        return {
            "id": deployment.id,
            "from": deployment.environment,
            "status": deployment.status.value,
            "commit_sha": deployment.commit_sha,
        }
    except Exception as exc:
        log.error(f"CI/CD promote failed: {exc}")
        return {"error": str(exc)}


@app.post("/cicd/rollback")
async def cicd_rollback(req: CICDRollbackRequest):
    """Rollback an environment."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        environment = Environment(req.env)
        if req.deployment_id:
            deployment = await cicd.rollback_to(
                env=environment,
                deployment_id=req.deployment_id,
                reason=req.reason,
                rolled_back_by=req.rolled_back_by,
            )
        else:
            deployment = await cicd.rollback(
                env=environment,
                reason=req.reason,
                rolled_back_by=req.rolled_back_by,
            )
        if not deployment:
            return {"error": "No previous deployment to rollback to"}
        return {
            "id": deployment.id,
            "environment": deployment.environment,
            "status": deployment.status.value,
            "commit_sha": deployment.commit_sha,
        }
    except Exception as exc:
        log.error(f"CI/CD rollback failed: {exc}")
        return {"error": str(exc)}


@app.post("/cicd/configure")
async def cicd_configure(req: CICDConfigureRequest):
    """Configure an environment."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        environment = Environment(req.env)
        if req.url:
            cicd.configure_environment(environment, url=req.url)
        if req.branch:
            cicd.configure_environment(environment, branch=req.branch)
        config = cicd.environments.get(environment)
        return {
            "status": "configured",
            "environment": req.env,
            "url": config.url if config else None,
            "branch": config.branch if config else None,
        }
    except Exception as exc:
        log.error(f"CI/CD configure failed: {exc}")
        return {"error": str(exc)}


@app.get("/cicd/history")
async def cicd_history(env: str | None = None, limit: int = 10):
    """Get deployment history."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        if env:
            environment = Environment(env)
            deployments = cicd.get_deployment_history(environment, limit)
        else:
            deployments = cicd.get_deployment_history(limit=limit)
        return [
            {
                "id": d.id,
                "environment": d.environment,
                "status": d.status.value,
                "commit_sha": d.commit_sha,
                "deployed_at": d.deployed_at.isoformat(),
                "duration_seconds": d.duration_seconds,
            }
            for d in deployments
        ]
    except Exception as exc:
        log.error(f"CI/CD history failed: {exc}")
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Custom Workflow Editor — Phase 5 enhancement
# ---------------------------------------------------------------------------

class WorkflowCreateRequest(BaseModel):
    name: str
    description: str | None = None


class WorkflowGenerateRequest(BaseModel):
    template: str


class WorkflowValidateRequest(BaseModel):
    filename: str


class WorkflowDryRunRequest(BaseModel):
    filename: str


class WorkflowAddJobRequest(BaseModel):
    filename: str
    job_id: str
    job_name: str
    runs_on: str | None = None


class WorkflowAddStepRequest(BaseModel):
    filename: str
    job_id: str
    step_id: str
    step_name: str
    action: str
    config: dict | None = None


class WorkflowDeleteRequest(BaseModel):
    filename: str


# In-memory workflow editor instance
_workflow_editor = None


def _get_workflow_editor():
    global _workflow_editor
    if _workflow_editor is None:
        import sys as _sys
        import pathlib as _pl
        _root = str(_pl.Path(__file__).resolve().parents[1])
        if _root not in _sys.path:
            _sys.path.insert(0, _root)
        from agents.phase5.workflow_editor import create_workflow_editor
        _workflow_editor = create_workflow_editor()
    return _workflow_editor


@app.get("/workflow/list")
async def workflow_list():
    """List all workflows."""
    try:
        editor = _get_workflow_editor()
        workflows = editor.list_workflows()
        return {"workflows": workflows}
    except Exception as exc:
        log.error(f"Workflow list failed: {exc}")
        return {"error": str(exc)}


@app.post("/workflow/create")
async def workflow_create(req: WorkflowCreateRequest):
    """Create a new workflow."""
    try:
        editor = _get_workflow_editor()
        from agents.phase5.workflow_editor import WorkflowEditor, Workflow
        workflow = editor.create_workflow(req.name, req.description or "")
        filepath = editor.save(workflow)
        return {
            "status": "created",
            "workflow": req.name,
            "file": filepath,
        }
    except Exception as exc:
        log.error(f"Workflow create failed: {exc}")
        return {"error": str(exc)}


@app.post("/workflow/generate")
async def workflow_generate(req: WorkflowGenerateRequest):
    """Generate a workflow from template."""
    try:
        editor = _get_workflow_editor()
        templates = {
            "node": editor._create_node_template,
            "python": editor._create_python_template,
            "fullstack": editor._create_fullstack_template,
            "deploy": editor._create_deploy_template,
        }
        if req.template not in templates:
            return {"error": f"Unknown template: {req.template}"}

        workflow = templates[req.template]()
        filepath = editor.save(workflow)
        return {
            "status": "created",
            "workflow": workflow.name,
            "file": filepath,
        }
    except Exception as exc:
        log.error(f"Workflow generate failed: {exc}")
        return {"error": str(exc)}


@app.post("/workflow/validate")
async def workflow_validate(req: WorkflowValidateRequest):
    """Validate a workflow."""
    try:
        editor = _get_workflow_editor()
        workflow = editor.load(req.filename)
        if not workflow:
            return {"valid": False, "errors": ["Workflow not found"]}

        errors = editor.validate(workflow)
        return {"valid": len(errors) == 0, "errors": errors}
    except Exception as exc:
        log.error(f"Workflow validate failed: {exc}")
        return {"valid": False, "error": str(exc)}


@app.post("/workflow/dry-run")
async def workflow_dry_run(req: WorkflowDryRunRequest):
    """Preview a workflow."""
    try:
        editor = _get_workflow_editor()
        workflow = editor.load(req.filename)
        if not workflow:
            return {"error": "Workflow not found"}

        preview = editor.dry_run(workflow)
        return {"workflow": workflow.name, "preview": preview}
    except Exception as exc:
        log.error(f"Workflow dry-run failed: {exc}")
        return {"error": str(exc)}


@app.post("/workflow/add-job")
async def workflow_add_job(req: WorkflowAddJobRequest):
    """Add a job to a workflow."""
    try:
        editor = _get_workflow_editor()
        workflow = editor.load(req.filename)
        if not workflow:
            return {"error": "Workflow not found"}

        editor.add_job(workflow, req.job_id, req.job_name, req.runs_on or "ubuntu-latest")
        editor.save(workflow)
        return {"status": "added", "job_id": req.job_id}
    except Exception as exc:
        log.error(f"Workflow add-job failed: {exc}")
        return {"error": str(exc)}


@app.post("/workflow/add-step")
async def workflow_add_step(req: WorkflowAddStepRequest):
    """Add a step to a workflow job."""
    try:
        editor = _get_workflow_editor()
        workflow = editor.load(req.filename)
        if not workflow:
            return {"error": "Workflow not found"}

        from agents.phase5.workflow_editor import WorkflowAction
        action = WorkflowAction(req.action)

        editor.add_step(workflow, req.job_id, req.step_id, req.step_name, action, req.config)
        editor.save(workflow)
        return {"status": "added", "step_id": req.step_id}
    except Exception as exc:
        log.error(f"Workflow add-step failed: {exc}")
        return {"error": str(exc)}


@app.post("/workflow/delete")
async def workflow_delete(req: WorkflowDeleteRequest):
    """Delete a workflow."""
    try:
        editor = _get_workflow_editor()
        filepath = editor.workflow_dir / req.filename
        if filepath.exists():
            filepath.unlink()
        return {"status": "deleted"}
    except Exception as exc:
        log.error(f"Workflow delete failed: {exc}")
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Multi-Environment CI/CD — Phase 5 enhancement
# ---------------------------------------------------------------------------

class CICDDeployRequest(BaseModel):
    env: str
    commit_sha: str
    branch: str | None = None
    deployed_by: str = "cli"


class CICDPromoteRequest(BaseModel):
    from_env: str
    to_env: str
    promoted_by: str = "cli"


class CICDRollbackRequest(BaseModel):
    env: str
    reason: str
    deployment_id: str | None = None
    rolled_back_by: str = "cli"


class CICDConfigureRequest(BaseModel):
    env: str
    url: str | None = None
    branch: str | None = None
    auto_promote: bool | None = None


# In-memory CICD instance
_cicd_client = None


def _get_cicd():
    global _cicd_client
    if _cicd_client is None:
        import sys as _sys
        import pathlib as _pl
        _root = str(_pl.Path(__file__).resolve().parents[1])
        if _root not in _sys.path:
            _sys.path.insert(0, _root)
        from agents.phase5.multi_env_cicd import create_cicd
        _cicd_client = create_cicd()
    return _cicd_client


@app.get("/cicd/status")
async def cicd_status(env: str | None = None):
    """Get CI/CD status for environments."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        if env:
            return cicd.get_status(Environment(env))
        return cicd.get_all_status()
    except Exception as exc:
        log.error(f"CI/CD status failed: {exc}")
        return {"error": str(exc)}


@app.post("/cicd/deploy")
async def cicd_deploy(req: CICDDeployRequest):
    """Deploy to an environment."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        deployment = await cicd.deploy(
            env=Environment(req.env),
            commit_sha=req.commit_sha,
            branch=req.branch,
            deployed_by=req.deployed_by,
        )
        return {
            "id": deployment.id,
            "environment": deployment.environment,
            "status": deployment.status.value,
            "commit_sha": deployment.commit_sha,
            "url": deployment.url,
        }
    except Exception as exc:
        log.error(f"CI/CD deploy failed: {exc}")
        return {"error": str(exc)}


@app.post("/cicd/promote")
async def cicd_promote(req: CICDPromoteRequest):
    """Promote from one environment to another."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        deployment = await cicd.promote(
            from_env=Environment(req.from_env),
            to_env=Environment(req.to_env),
            promoted_by=req.promoted_by,
        )
        return {
            "id": deployment.id,
            "from": deployment.environment,
            "status": deployment.status.value,
            "commit_sha": deployment.commit_sha,
        }
    except Exception as exc:
        log.error(f"CI/CD promote failed: {exc}")
        return {"error": str(exc)}


@app.post("/cicd/rollback")
async def cicd_rollback(req: CICDRollbackRequest):
    """Rollback an environment."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        deployment = await cicd.rollback(
            env=Environment(req.env),
            reason=req.reason,
            rolled_back_by=req.rolled_back_by,
        )
        if not deployment:
            return {"error": "No previous deployment to rollback to"}
        return {
            "id": deployment.id,
            "environment": deployment.environment,
            "status": deployment.status.value,
            "commit_sha": deployment.commit_sha,
        }
    except Exception as exc:
        log.error(f"CI/CD rollback failed: {exc}")
        return {"error": str(exc)}


@app.post("/cicd/configure")
async def cicd_configure(req: CICDConfigureRequest):
    """Configure an environment."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        cicd.configure_environment(
            env=Environment(req.env),
            url=req.url,
            branch=req.branch,
        )
        config = cicd.environments.get(Environment(req.env))
        return {
            "status": "configured",
            "environment": req.env,
            "url": config.url if config else None,
            "branch": config.branch if config else None,
        }
    except Exception as exc:
        log.error(f"CI/CD configure failed: {exc}")
        return {"error": str(exc)}


@app.get("/cicd/history")
async def cicd_history(env: str | None = None, limit: int = 10):
    """Get deployment history."""
    try:
        cicd = _get_cicd()
        from agents.phase5.multi_env_cicd import Environment
        env_obj = Environment(env) if env else None
        deployments = cicd.get_deployment_history(env_obj, limit)
        return [
            {
                "id": d.id,
                "environment": d.environment,
                "status": d.status.value,
                "commit_sha": d.commit_sha,
                "deployed_at": d.deployed_at.isoformat(),
                "duration_seconds": d.duration_seconds,
            }
            for d in deployments
        ]
    except Exception as exc:
        log.error(f"CI/CD history failed: {exc}")
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Phase 4 Auto-Retry — Auto-trigger Phase 3 when QA finds issues
# ---------------------------------------------------------------------------

class AutoRetryAnalyzeRequest(BaseModel):
    phase4_report: dict


class AutoRetryExecuteRequest(BaseModel):
    category: str
    files: list[str] = []
    reason: str = ""


_auto_retry_client = None


def _get_auto_retry():
    global _auto_retry_client
    if _auto_retry_client is None:
        import sys as _sys
        import pathlib as _pl
        _root = str(_pl.Path(__file__).resolve().parents[1])
        if _root not in _sys.path:
            _sys.path.insert(0, _root)
        from agents.phase4.auto_retry import create_auto_retry
        _auto_retry_client = create_auto_retry()
    return _auto_retry_client


@app.get("/phase4/auto-retry/status")
async def auto_retry_status():
    """Get auto-retry status."""
    try:
        auto_retry = _get_auto_retry()
        return auto_retry.get_retry_status()
    except Exception as exc:
        log.error(f"Auto-retry status failed: {exc}")
        return {"error": str(exc)}


@app.post("/phase4/auto-retry/analyze")
async def auto_retry_analyze(req: AutoRetryAnalyzeRequest):
    """Analyze Phase 4 report and suggest retries."""
    try:
        auto_retry = _get_auto_retry()
        tasks = auto_retry.analyze_findings(req.phase4_report)
        return {
            "suggested_retries": [
                {
                    "category": task.category.value,
                    "subagent": task.subagent,
                    "files": task.files,
                    "reason": task.reason,
                }
                for task in tasks
            ],
            "total": len(tasks),
        }
    except Exception as exc:
        log.error(f"Auto-retry analyze failed: {exc}")
        return {"error": str(exc)}


@app.post("/phase4/auto-retry/execute")
async def auto_retry_execute(req: AutoRetryExecuteRequest):
    """Execute a retry task."""
    try:
        auto_retry = _get_auto_retry()
        from agents.phase4.auto_retry import RetryTask, RetryCategory
        task = RetryTask(
            subagent="subagent-4",
            files=req.files,
            reason=req.reason,
            category=RetryCategory(req.category),
        )
        result = await auto_retry.execute_retry(task)
        return {
            "retry_id": result.retry_id,
            "status": result.status,
            "error": result.error,
        }
    except Exception as exc:
        log.error(f"Auto-retry execute failed: {exc}")
        return {"error": str(exc)}


@app.post("/phase4/auto-retry/clear")
async def auto_retry_clear():
    """Clear retry history."""
    try:
        auto_retry = _get_auto_retry()
        auto_retry.clear_history()
        return {"status": "cleared"}
    except Exception as exc:
        log.error(f"Auto-retry clear failed: {exc}")
        return {"error": str(exc)}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pakalon Python Bridge Server")
    parser.add_argument("--port", type=int, default=7432, help="Port to listen on")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()

    log.info(f"Starting bridge server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
