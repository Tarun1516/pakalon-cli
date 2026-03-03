"""
mem0_client.py — Mem0 memory layer for Pakalon agents.
T094: Mem0Client with add/search/get_all/delete; namespaced by user_id:project_dir_hash.
"""
from __future__ import annotations

import os
from typing import Any

try:
    from mem0 import Memory  # type: ignore
    MEM0_AVAILABLE = True
except ImportError:
    MEM0_AVAILABLE = False


class Mem0Client:
    """
    Thin wrapper around mem0ai SDK.
    Namespace: {user_id}:{project_dir_hash}
    """

    def __init__(self, user_id: str, project_dir_hash: str = "global") -> None:
        self.user_id = user_id
        self.namespace = f"{user_id}:{project_dir_hash}"
        self._mem: Any = None
        if MEM0_AVAILABLE:
            config: dict[str, Any] = {}
            api_key = os.environ.get("MEM0_API_KEY")
            if api_key:
                config["api_key"] = api_key
            self._mem = Memory(config=config) if config else Memory()

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def add(self, content: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        """Add a memory entry for this namespace."""
        if self._mem is None:
            return {"id": "noop", "text": content, "namespace": self.namespace}
        meta = {"namespace": self.namespace, **(metadata or {})}
        result = self._mem.add(content, user_id=self.namespace, metadata=meta)
        return result  # type: ignore[return-value]

    def search(
        self,
        query: str,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        """Semantic search over memories in this namespace."""
        if self._mem is None:
            return []
        results = self._mem.search(query, user_id=self.namespace, limit=limit)
        return results if isinstance(results, list) else results.get("results", [])  # type: ignore[return-value]

    def get_all(self) -> list[dict[str, Any]]:
        """Return all memories for this namespace."""
        if self._mem is None:
            return []
        results = self._mem.get_all(user_id=self.namespace)
        return results if isinstance(results, list) else results.get("results", [])  # type: ignore[return-value]

    def delete(self, memory_id: str) -> bool:
        """Delete a memory by its ID."""
        if self._mem is None:
            return False
        try:
            self._mem.delete(memory_id=memory_id)
            return True
        except Exception:
            return False

    def delete_all(self) -> bool:
        """Delete all memories for this namespace."""
        if self._mem is None:
            return False
        try:
            self._mem.delete_all(user_id=self.namespace)
            return True
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    def store_qa(self, question: str, answer: str) -> None:
        """Store a Q&A pair (Phase 1 planning context)."""
        self.add(
            f"Q: {question}\nA: {answer}",
            metadata={"type": "qa"},
        )

    def store_design_decision(self, decision: str, rationale: str) -> None:
        """Store an architectural/design decision."""
        self.add(
            f"Decision: {decision}\nRationale: {rationale}",
            metadata={"type": "design_decision"},
        )

    def recall_context(self, query: str, limit: int = 10) -> str:
        """Return a formatted context block from top memories."""
        results = self.search(query, limit=limit)
        if not results:
            return ""
        lines = ["## Memory Context"]
        for i, r in enumerate(results, 1):
            text = r.get("text") or r.get("memory") or ""
            lines.append(f"{i}. {text}")
        return "\n".join(lines)
