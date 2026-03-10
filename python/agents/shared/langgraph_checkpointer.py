"""
langgraph_checkpointer.py — LangGraph MemorySaver checkpointer helpers.
T-RAG-01C: Formal LangGraph checkpoint integration for all phase graphs.

Each phase graph is compiled with an in-memory MemorySaver checkpointer so that:
  1. LangGraph can persist state between nodes (enabling HIL interrupt/resume).
  2. Crash recovery within a session is possible via thread-scoped checkpoints.
  3. Cross-phase Mem0 summaries are stored at each phase boundary.

Usage::

    from ..shared.langgraph_checkpointer import build_checkpointer, thread_config

    # At graph compile time:
    graph = raw_graph.compile(checkpointer=build_checkpointer())

    # At graph invocation time (pass thread config):
    state = await graph.ainvoke(initial, config=thread_config(user_id, project_dir))
"""
from __future__ import annotations

import hashlib
import pathlib
from typing import Any

# ---------------------------------------------------------------------------
# MemorySaver import — LangGraph ≥ 0.2 ships langgraph.checkpoint.memory
# ---------------------------------------------------------------------------

try:
    from langgraph.checkpoint.memory import MemorySaver  # type: ignore
    _CHECKPOINTER_AVAILABLE = True
except ImportError:
    MemorySaver = None  # type: ignore
    _CHECKPOINTER_AVAILABLE = False


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def build_checkpointer() -> Any:
    """
    Return a new ``MemorySaver`` instance for use as a LangGraph checkpointer.

    Returns *None* if LangGraph checkpoint support is unavailable, which
    causes the caller to fall back to ``.compile()`` without a checkpointer.
    """
    if not _CHECKPOINTER_AVAILABLE or MemorySaver is None:
        return None
    return MemorySaver()


def _thread_id(user_id: str, project_dir: str, phase: int) -> str:
    """Deterministic thread ID scoped to user + project + phase."""
    raw = f"{user_id}:{pathlib.Path(project_dir).resolve()}:{phase}"
    return hashlib.md5(raw.encode()).hexdigest()[:24]


def thread_config(user_id: str, project_dir: str, phase: int = 0) -> dict[str, Any]:
    """
    Build a LangGraph runnable config with ``thread_id`` set.

    Pass the returned dict as the ``config=`` argument to ``graph.ainvoke()``::

        state = await graph.ainvoke(initial, config=thread_config(user_id, project_dir, phase=3))
    """
    return {"configurable": {"thread_id": _thread_id(user_id, project_dir, phase)}}


def store_phase_mem0(user_id: str, project_dir: str, phase: int, summary: str) -> None:
    """
    Persist a phase-completion summary to Mem0 so downstream phases can read it.
    Silently no-ops if Mem0 is unavailable.
    """
    try:
        from .mem0_context import store_phase_summary  # noqa: PLC0415
        store_phase_summary(user_id, project_dir, phase, summary)
    except Exception:
        pass
