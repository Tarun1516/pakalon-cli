"""
execution_log.py — Phase 3 ExecutionLog: append-only log of agent actions.
T111: Writes phase-3/execution_log.md with timestamped entries. Thread-safe.
"""
from __future__ import annotations

import datetime
import os
import pathlib
import threading
from typing import Any

from ..shared.paths import get_phase_dir


class ExecutionLog:
    """
    Append-only log file for Phase 3 sub-agent actions.
    Thread-safe. Falls back to in-memory if disk write fails.
    """

    def __init__(self, log_path: str | None = None, project_dir: str = "."):
        if log_path:
            self.log_path = pathlib.Path(log_path)
        else:
            p = get_phase_dir(project_dir, 3)
            p.mkdir(parents=True, exist_ok=True)
            self.log_path = p / "execution_log.md"
        self._lock = threading.Lock()
        self._entries: list[str] = []
        self._init_file()

    def _init_file(self) -> None:
        if not self.log_path.exists():
            self.log_path.write_text("# Phase 3 Execution Log\n\n")

    # ------------------------------------------------------------------

    def log(
        self,
        agent: str,
        action: str,
        detail: str = "",
        status: str = "info",
        metadata: dict | None = None,
    ) -> None:
        """Append a log entry."""
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        icon = {"info": "ℹ️", "success": "✅", "warning": "⚠️", "error": "❌", "start": "🚀", "end": "🏁"}.get(status, "•")
        entry = f"### {icon} [{ts}] {agent} — {action}\n"
        if detail:
            entry += f"\n{detail}\n"
        if metadata:
            entry += f"\n```json\n{__import__('json').dumps(metadata, indent=2)}\n```\n"
        entry += "\n---\n\n"

        with self._lock:
            self._entries.append(entry)
            try:
                with self.log_path.open("a") as f:
                    f.write(entry)
            except Exception:
                pass  # Keep in-memory only

    def log_start(self, agent: str, task: str) -> None:
        self.log(agent, f"START: {task}", status="start")

    def log_end(self, agent: str, task: str, success: bool = True) -> None:
        self.log(agent, f"END: {task}", status="success" if success else "error")

    def log_file_created(self, agent: str, path: str) -> None:
        self.log(agent, f"Created file: {path}", status="success")

    def log_file_modified(self, agent: str, path: str, summary: str = "") -> None:
        self.log(agent, f"Modified file: {path}", detail=summary, status="info")

    def log_error(self, agent: str, error: str) -> None:
        self.log(agent, "Error occurred", detail=error, status="error")

    def log_command(self, agent: str, cmd: list) -> None:
        """Log a terminal command invocation."""
        self.log(agent, f"Run command: {' '.join(str(c) for c in cmd)}", status="info")

    def log_command_result(self, agent: str, returncode: int, output_snippet: str = "") -> None:
        """Log terminal command result."""
        status = "success" if returncode == 0 else "warning"
        detail = f"Exit code: {returncode}" + (f"\n{output_snippet}" if output_snippet else "")
        self.log(agent, f"Command exited {returncode}", detail=detail, status=status)

    # ------------------------------------------------------------------

    def read(self) -> str:
        """Return full log content."""
        try:
            return self.log_path.read_text()
        except Exception:
            return "\n".join(self._entries)

    def get_entries(self) -> list[str]:
        """Return in-memory entries list."""
        with self._lock:
            return list(self._entries)

    def get_summary(self) -> dict:
        """Return counts by status."""
        counts: dict = {"total": len(self._entries)}
        for entry in self._entries:
            if "✅" in entry:
                counts["success"] = counts.get("success", 0) + 1
            elif "❌" in entry:
                counts["error"] = counts.get("error", 0) + 1
            elif "⚠️" in entry:
                counts["warning"] = counts.get("warning", 0) + 1
        return counts
