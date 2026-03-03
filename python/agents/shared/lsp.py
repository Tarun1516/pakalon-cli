"""
lsp.py — Language Server Protocol client for Pakalon AI agents.

Wraps multiple language servers (pyright, typescript-language-server, etc.)
via JSON-RPC over stdio, exposing:
  - go_to_definition
  - find_references
  - hover / code_completion
  - rename_symbol
  - diagnostics (publishDiagnostics)
  - workspace_symbols

Language server binaries are resolved from PATH; gracefully degraded when not available.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import subprocess
import threading
from typing import Any

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# JSON-RPC helpers
# ---------------------------------------------------------------------------

def _make_rpc(method: str, params: Any, req_id: int | None = None) -> bytes:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "params": params}
    if req_id is not None:
        msg["id"] = req_id
    body = json.dumps(msg).encode()
    header = f"Content-Length: {len(body)}\r\n\r\n".encode()
    return header + body


def _uri(path: str) -> str:
    p = pathlib.Path(path).resolve()
    return p.as_uri()


# ---------------------------------------------------------------------------
# LSP client (sync, subprocess-based)
# ---------------------------------------------------------------------------

class LSPClient:
    """
    Minimal synchronous LSP client.
    Spawns a language server subprocess and communicates via JSON-RPC over stdio.
    """

    def __init__(self, command: list[str], root_uri: str | None = None, workspace_dir: str | None = None):
        self._command = command
        self._root_uri = root_uri or _uri(workspace_dir or os.getcwd())
        self._workspace_dir = workspace_dir or os.getcwd()
        self._proc: subprocess.Popen | None = None
        self._req_id = 0
        self._responses: dict[int, dict] = {}
        self._diagnostics: dict[str, list[dict]] = {}  # uri -> [diagnostic]
        self._reader_thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._running = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> bool:
        """Start the language server process. Returns True on success."""
        try:
            self._proc = subprocess.Popen(
                self._command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=self._workspace_dir,
            )
            self._running = True
            self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
            self._reader_thread.start()

            # Send initialize request
            resp = self._request("initialize", {
                "processId": os.getpid(),
                "rootUri": self._root_uri,
                "rootPath": self._workspace_dir,
                "capabilities": {
                    "textDocument": {
                        "definition": {"dynamicRegistration": False, "linkSupport": False},
                        "references": {"dynamicRegistration": False},
                        "hover": {"dynamicRegistration": False, "contentFormat": ["plaintext", "markdown"]},
                        "completion": {"dynamicRegistration": False, "completionItem": {"snippetSupport": False}},
                        "rename": {"dynamicRegistration": False, "prepareSupport": False},
                        "publishDiagnostics": {"relatedInformation": True},
                        "documentSymbol": {"dynamicRegistration": False},
                    },
                    "workspace": {
                        "symbol": {"dynamicRegistration": False},
                        "applyEdit": False,
                    },
                },
                "initializationOptions": {},
            }, timeout=10)

            if resp and not resp.get("error"):
                self._notify("initialized", {})
                return True
            return False
        except Exception as exc:
            log.warning(f"LSP start failed ({self._command[0]}): {exc}")
            return False

    def stop(self) -> None:
        """Shutdown the language server."""
        self._running = False
        if self._proc:
            try:
                self._request("shutdown", None, timeout=3)
                self._notify("exit", None)
            except Exception:
                pass
            try:
                self._proc.terminate()
                self._proc.wait(timeout=2)
            except Exception:
                pass
            self._proc = None

    # ------------------------------------------------------------------
    # Internal I/O
    # ------------------------------------------------------------------

    def _read_loop(self) -> None:
        """Background thread: read JSON-RPC messages from stdout."""
        while self._running and self._proc and self._proc.stdout:
            try:
                # Read headers
                headers: dict[str, str] = {}
                while True:
                    line = self._proc.stdout.readline().decode("utf-8", errors="replace").strip()
                    if not line:
                        break
                    if ":" in line:
                        k, v = line.split(":", 1)
                        headers[k.strip().lower()] = v.strip()

                length = int(headers.get("content-length", 0))
                if length <= 0:
                    continue

                body = self._proc.stdout.read(length).decode("utf-8", errors="replace")
                msg = json.loads(body)

                if "id" in msg:
                    with self._lock:
                        self._responses[msg["id"]] = msg
                elif msg.get("method") == "textDocument/publishDiagnostics":
                    params = msg.get("params", {})
                    uri = params.get("uri", "")
                    self._diagnostics[uri] = params.get("diagnostics", [])
            except Exception:
                break

    def _write(self, data: bytes) -> None:
        if self._proc and self._proc.stdin:
            self._proc.stdin.write(data)
            self._proc.stdin.flush()

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _request(self, method: str, params: Any, timeout: float = 5.0) -> dict | None:
        req_id = self._next_id()
        self._write(_make_rpc(method, params, req_id))
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if req_id in self._responses:
                    return self._responses.pop(req_id)
            time.sleep(0.05)
        return None

    def _notify(self, method: str, params: Any) -> None:
        self._write(_make_rpc(method, params))

    # ------------------------------------------------------------------
    # Public LSP operations
    # ------------------------------------------------------------------

    def open_file(self, file_path: str) -> None:
        """Notify the server that a file is open."""
        content = pathlib.Path(file_path).read_text(errors="replace")
        ext = pathlib.Path(file_path).suffix.lstrip(".")
        language_id = {"ts": "typescript", "tsx": "typescriptreact", "js": "javascript", "py": "python",
                       "go": "go", "rs": "rust", "java": "java", "cs": "csharp"}.get(ext, ext)
        self._notify("textDocument/didOpen", {
            "textDocument": {
                "uri": _uri(file_path),
                "languageId": language_id,
                "version": 1,
                "text": content,
            }
        })

    def go_to_definition(self, file_path: str, line: int, character: int) -> list[dict]:
        """Returns list of Location dicts with uri, range."""
        self.open_file(file_path)
        resp = self._request("textDocument/definition", {
            "textDocument": {"uri": _uri(file_path)},
            "position": {"line": line, "character": character},
        })
        if not resp:
            return []
        result = resp.get("result") or []
        if isinstance(result, dict):
            result = [result]
        return result or []

    def find_references(self, file_path: str, line: int, character: int, include_declaration: bool = True) -> list[dict]:
        """Returns list of Location dicts."""
        self.open_file(file_path)
        resp = self._request("textDocument/references", {
            "textDocument": {"uri": _uri(file_path)},
            "position": {"line": line, "character": character},
            "context": {"includeDeclaration": include_declaration},
        }, timeout=10)
        return resp.get("result") or [] if resp else []

    def hover(self, file_path: str, line: int, character: int) -> str:
        """Returns hover documentation as a string."""
        self.open_file(file_path)
        resp = self._request("textDocument/hover", {
            "textDocument": {"uri": _uri(file_path)},
            "position": {"line": line, "character": character},
        })
        if not resp:
            return ""
        result = resp.get("result") or {}
        contents = result.get("contents", "")
        if isinstance(contents, dict):
            return contents.get("value", "")
        if isinstance(contents, list):
            return "\n".join(
                c.get("value", "") if isinstance(c, dict) else str(c) for c in contents
            )
        return str(contents)

    def completion(self, file_path: str, line: int, character: int) -> list[dict]:
        """Returns list of CompletionItem dicts."""
        self.open_file(file_path)
        resp = self._request("textDocument/completion", {
            "textDocument": {"uri": _uri(file_path)},
            "position": {"line": line, "character": character},
            "context": {"triggerKind": 1},
        }, timeout=8)
        if not resp:
            return []
        result = resp.get("result") or {}
        if isinstance(result, dict):
            return result.get("items", [])
        return result or []

    def rename_symbol(self, file_path: str, line: int, character: int, new_name: str) -> dict:
        """Returns WorkspaceEdit dict."""
        self.open_file(file_path)
        resp = self._request("textDocument/rename", {
            "textDocument": {"uri": _uri(file_path)},
            "position": {"line": line, "character": character},
            "newName": new_name,
        }, timeout=10)
        return resp.get("result") or {} if resp else {}

    def workspace_symbols(self, query: str = "") -> list[dict]:
        """Returns list of SymbolInformation dicts."""
        resp = self._request("workspace/symbol", {"query": query}, timeout=10)
        return resp.get("result") or [] if resp else []

    def get_diagnostics(self, file_path: str | None = None) -> dict[str, list[dict]]:
        """Returns all known diagnostics, optionally filtered by file."""
        if file_path:
            uri = _uri(file_path)
            return {uri: self._diagnostics.get(uri, [])}
        return dict(self._diagnostics)


# ---------------------------------------------------------------------------
# Language server registry
# ---------------------------------------------------------------------------

_LS_COMMANDS: dict[str, list[str]] = {
    "typescript": ["typescript-language-server", "--stdio"],
    "javascript": ["typescript-language-server", "--stdio"],
    "python": ["pyright-langserver", "--stdio"],
    "rust": ["rust-analyzer"],
    "go": ["gopls"],
    "java": ["jdtls"],
    "csharp": ["omnisharp", "-lsp"],
}

_EXT_TO_LANG: dict[str, str] = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".cs": "csharp",
}

# Global singleton clients (one per language per workspace)
_clients: dict[str, LSPClient] = {}
_clients_lock = threading.Lock()


def _resolve_command(binary: str) -> bool:
    """Check if a binary is available on PATH."""
    import shutil
    return shutil.which(binary) is not None


def get_or_create_client(language: str, workspace_dir: str) -> LSPClient | None:
    """
    Return (or create) an LSP client for the given language + workspace.
    Returns None if the language server binary is not installed.
    """
    key = f"{language}:{workspace_dir}"
    with _clients_lock:
        if key in _clients:
            return _clients[key]

        cmd = _LS_COMMANDS.get(language)
        if not cmd:
            return None
        if not _resolve_command(cmd[0]):
            log.info(f"LSP binary not found: {cmd[0]} (install to enable {language} LSP)")
            return None

        client = LSPClient(cmd, workspace_dir=workspace_dir)
        if client.start():
            _clients[key] = client
            log.info(f"LSP client started for {language} @ {workspace_dir}")
            return client
        return None


def stop_all_clients() -> None:
    with _clients_lock:
        for client in _clients.values():
            try:
                client.stop()
            except Exception:
                pass
        _clients.clear()


def detect_language(file_path: str) -> str | None:
    ext = pathlib.Path(file_path).suffix.lower()
    return _EXT_TO_LANG.get(ext)


# ---------------------------------------------------------------------------
# High-level convenience functions (called by bridge server)
# ---------------------------------------------------------------------------

def lsp_go_to_definition(file_path: str, line: int, character: int, workspace_dir: str) -> dict:
    lang = detect_language(file_path)
    if not lang:
        return {"error": f"Unknown language for {file_path}"}
    client = get_or_create_client(lang, workspace_dir)
    if not client:
        return {"error": f"LSP server not available for {lang}. Install {_LS_COMMANDS.get(lang, ['?'])[0]}"}
    locations = client.go_to_definition(file_path, line, character)
    return {"locations": locations, "count": len(locations)}


def lsp_find_references(file_path: str, line: int, character: int, workspace_dir: str) -> dict:
    lang = detect_language(file_path)
    if not lang:
        return {"error": f"Unknown language for {file_path}"}
    client = get_or_create_client(lang, workspace_dir)
    if not client:
        return {"error": f"LSP server not available for {lang}"}
    refs = client.find_references(file_path, line, character)
    return {"references": refs, "count": len(refs)}


def lsp_hover(file_path: str, line: int, character: int, workspace_dir: str) -> dict:
    lang = detect_language(file_path)
    if not lang:
        return {"error": f"Unknown language for {file_path}"}
    client = get_or_create_client(lang, workspace_dir)
    if not client:
        return {"error": f"LSP server not available for {lang}"}
    text = client.hover(file_path, line, character)
    return {"hover": text}


def lsp_completion(file_path: str, line: int, character: int, workspace_dir: str) -> dict:
    lang = detect_language(file_path)
    if not lang:
        return {"error": f"Unknown language for {file_path}"}
    client = get_or_create_client(lang, workspace_dir)
    if not client:
        return {"error": f"LSP server not available for {lang}"}
    items = client.completion(file_path, line, character)
    # Trim to top 20 most relevant
    trimmed = [{"label": i.get("label", ""), "kind": i.get("kind", 1), "detail": i.get("detail", ""), "documentation": i.get("documentation", "")} for i in items[:20]]
    return {"items": trimmed, "total": len(items)}


def lsp_rename(file_path: str, line: int, character: int, new_name: str, workspace_dir: str) -> dict:
    lang = detect_language(file_path)
    if not lang:
        return {"error": f"Unknown language for {file_path}"}
    client = get_or_create_client(lang, workspace_dir)
    if not client:
        return {"error": f"LSP server not available for {lang}"}
    edit = client.rename_symbol(file_path, line, character, new_name)
    return {"workspace_edit": edit}


def lsp_diagnostics(file_path: str, workspace_dir: str) -> dict:
    lang = detect_language(file_path)
    if not lang:
        return {"error": f"Unknown language for {file_path}", "diagnostics": []}
    client = get_or_create_client(lang, workspace_dir)
    if not client:
        return {"error": f"LSP server not available for {lang}", "diagnostics": []}
    # Trigger diagnostics by opening the file
    try:
        client.open_file(file_path)
    except Exception:
        pass
    import time; time.sleep(0.5)  # wait for publishDiagnostics
    diags = client.get_diagnostics(file_path)
    import pathlib as _p
    uri_key = _p.Path(file_path).resolve().as_uri()
    return {"diagnostics": diags.get(uri_key, []), "file": file_path}


def lsp_workspace_symbols(query: str, workspace_dir: str, language: str | None = None) -> dict:
    """Search workspace symbols across all running language servers."""
    results: list[dict] = []
    lang_list = [language] if language else list(_LS_COMMANDS.keys())
    for lang in lang_list:
        client = get_or_create_client(lang, workspace_dir)
        if client:
            syms = client.workspace_symbols(query)
            results.extend(syms[:50])
    return {"symbols": results[:100], "count": len(results)}


def lsp_status(workspace_dir: str) -> dict:
    """Return which language servers are running and available binaries."""
    import shutil
    available: list[dict] = []
    running: list[str] = []

    for lang, cmd in _LS_COMMANDS.items():
        binary = cmd[0]
        installed = bool(shutil.which(binary))
        key = f"{lang}:{workspace_dir}"
        is_running = key in _clients
        available.append({"language": lang, "binary": binary, "installed": installed, "running": is_running})
        if is_running:
            running.append(lang)

    return {"servers": available, "running": running}
