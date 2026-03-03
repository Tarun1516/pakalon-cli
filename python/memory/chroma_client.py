"""
chroma_client.py — ChromaDB vector store client for Pakalon agents.
T095: ChromaClient with upsert/query/delete; persistent store in ~/.config/pakalon/chroma/
"""
from __future__ import annotations

import hashlib
import os
import pathlib
from typing import Any

try:
    import chromadb  # type: ignore
    from chromadb.config import Settings as ChromaSettings  # type: ignore
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False

DEFAULT_CHROMA_DIR = pathlib.Path.home() / ".config" / "pakalon" / "chroma"


class ChromaClient:
    """
    Thin wrapper around chromadb for persistent local vector storage.
    Collection is always created in DEFAULT_CHROMA_DIR.
    """

    def __init__(self, collection_name: str, persist_dir: str | pathlib.Path | None = None) -> None:
        self.collection_name = collection_name
        self._dir = pathlib.Path(persist_dir or DEFAULT_CHROMA_DIR)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._client: Any = None
        self._collection: Any = None

        if CHROMA_AVAILABLE:
            self._client = chromadb.PersistentClient(
                path=str(self._dir),
                settings=ChromaSettings(anonymized_telemetry=False),
            )
            self._collection = self._client.get_or_create_collection(
                name=collection_name,
                metadata={"hnsw:space": "cosine"},
            )

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def upsert(
        self,
        doc_id: str,
        document: str,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        """Upsert a document. Returns True on success."""
        if self._collection is None:
            return False
        try:
            self._collection.upsert(
                ids=[doc_id],
                documents=[document],
                metadatas=[metadata or {}],
            )
            return True
        except Exception:
            return False

    def query(
        self,
        text: str,
        n_results: int = 5,
        where: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Query the collection by semantic similarity.
        Returns list of {id, document, metadata, distance}.
        """
        if self._collection is None:
            return []
        kwargs: dict[str, Any] = {"query_texts": [text], "n_results": n_results}
        if where:
            kwargs["where"] = where
        try:
            result = self._collection.query(**kwargs)
            ids = result.get("ids", [[]])[0]
            docs = result.get("documents", [[]])[0]
            metas = result.get("metadatas", [[]])[0]
            dists = result.get("distances", [[]])[0]
            return [
                {"id": ids[i], "document": docs[i], "metadata": metas[i], "distance": dists[i]}
                for i in range(len(ids))
            ]
        except Exception:
            return []

    def delete(self, doc_id: str) -> bool:
        """Delete a document by ID."""
        if self._collection is None:
            return False
        try:
            self._collection.delete(ids=[doc_id])
            return True
        except Exception:
            return False

    def delete_where(self, where: dict[str, Any]) -> bool:
        """Delete all documents matching a metadata filter."""
        if self._collection is None:
            return False
        try:
            self._collection.delete(where=where)
            return True
        except Exception:
            return False

    def count(self) -> int:
        """Return number of documents in the collection."""
        if self._collection is None:
            return 0
        try:
            return self._collection.count()
        except Exception:
            return 0

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def stable_id(text: str) -> str:
        """Generate a stable ID from content hash."""
        return hashlib.sha256(text.encode()).hexdigest()[:16]

    def upsert_file(self, path: str, content: str, extra_meta: dict[str, Any] | None = None) -> bool:
        """Convenience: upsert a file with path as metadata."""
        doc_id = self.stable_id(path)
        meta = {"file_path": path, **(extra_meta or {})}
        return self.upsert(doc_id, content, meta)

    def search_files(self, query: str, n_results: int = 5) -> list[dict[str, Any]]:
        """Search documents that have a file_path metadata field."""
        return self.query(query, n_results=n_results, where={"file_path": {"$ne": ""}})
