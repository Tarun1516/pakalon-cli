"""
mem0_context.py — Cross-phase Mem0 context retrieval utility.
T163 / T-CLI-26: Phases 2-6 read from phase 1's Mem0 context
to maintain continuity across the full pipeline.
"""
from __future__ import annotations

import hashlib
import os
import pathlib
from typing import Any


def _project_hash(project_dir: str) -> str:
    return hashlib.md5(str(pathlib.Path(project_dir).resolve()).encode()).hexdigest()[:12]


def retrieve_phase1_context(
    user_id: str,
    project_dir: str,
    query: str = "project requirements design decisions user preferences",
    limit: int = 8,
) -> str:
    """
    Retrieve Phase 1 planning context from Mem0 for use in phases 2-6.

    Returns a formatted string that can be prepended to system prompts.
    Returns an empty string if Mem0 is unavailable or no memories found.
    """
    try:
        from ..memory.mem0_client import Mem0Client  # type: ignore
        client = Mem0Client(user_id=user_id, project_dir_hash=_project_hash(project_dir))
        memories = client.search(query, limit=limit)
        if not memories:
            return ""
        lines: list[str] = ["## Phase 1 Context (from memory)"]
        for m in memories:
            text = m.get("memory") or m.get("text", "")
            if text:
                lines.append(f"- {text}")
        return "\n".join(lines) + "\n"
    except Exception:
        return ""


def store_phase_summary(
    user_id: str,
    project_dir: str,
    phase: int,
    summary: str,
) -> None:
    """Store a phase summary to Mem0 for downstream phases to read."""
    try:
        from ..memory.mem0_client import Mem0Client  # type: ignore
        client = Mem0Client(user_id=user_id, project_dir_hash=_project_hash(project_dir))
        client.add(f"Phase {phase} summary: {summary[:500]}", metadata={"phase": phase})
    except Exception:
        pass
