"""
lance_client.py — LanceDB vector store for file attachments (PDFs, images, Figma JSON).
T096: LanceClient with add_file/search; semantic search over binary/text content.
"""
from __future__ import annotations

import base64
import hashlib
import mimetypes
import pathlib
from typing import Any

try:
    import lancedb  # type: ignore
    LANCE_AVAILABLE = True
except ImportError:
    LANCE_AVAILABLE = False

try:
    from sentence_transformers import SentenceTransformer  # type: ignore
    ST_AVAILABLE = True
except ImportError:
    ST_AVAILABLE = False

DEFAULT_LANCE_DIR = pathlib.Path.home() / ".config" / "pakalon" / "lancedb"
DEFAULT_TABLE = "pakalon_files"
EMBED_MODEL = "all-MiniLM-L6-v2"  # small + fast; ~80MB
EMBED_DIM = 384


class LanceClient:
    """
    File vector store backed by LanceDB.
    Supports PDFs (text extraction), images (base64 stub),
    and Figma JSON exports (stringified).
    """

    def __init__(self, db_path: str | pathlib.Path | None = None, table: str = DEFAULT_TABLE) -> None:
        self._path = pathlib.Path(db_path or DEFAULT_LANCE_DIR)
        self._path.mkdir(parents=True, exist_ok=True)
        self._table_name = table
        self._db: Any = None
        self._table: Any = None
        self._embedder: Any = None

        if LANCE_AVAILABLE:
            self._db = lancedb.connect(str(self._path))
        if ST_AVAILABLE:
            self._embedder = SentenceTransformer(EMBED_MODEL)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _embed(self, text: str) -> list[float]:
        if self._embedder is None:
            return [0.0] * EMBED_DIM
        return self._embedder.encode(text, convert_to_list=True)  # type: ignore[return-value]

    def _get_or_create_table(self) -> Any:
        if self._db is None:
            return None
        if self._table is not None:
            return self._table
        try:
            import pyarrow as pa  # type: ignore
            schema = pa.schema([
                pa.field("id", pa.utf8()),
                pa.field("path", pa.utf8()),
                pa.field("mime_type", pa.utf8()),
                pa.field("content_text", pa.utf8()),
                pa.field("vector", pa.list_(pa.float32(), EMBED_DIM)),
            ])
            try:
                self._table = self._db.open_table(self._table_name)
            except Exception:
                self._table = self._db.create_table(self._table_name, schema=schema)
        except Exception:
            self._table = None
        return self._table

    @staticmethod
    def _file_id(path: str) -> str:
        return hashlib.sha256(path.encode()).hexdigest()[:16]

    @staticmethod
    def _extract_text(content_bytes: bytes, mime_type: str) -> str:
        """Extract searchable text from binary content."""
        if mime_type.startswith("text/") or mime_type == "application/json":
            return content_bytes.decode("utf-8", errors="replace")

        if mime_type == "application/pdf":
            try:
                import io
                import pdfplumber  # type: ignore
                pages = []
                with pdfplumber.open(io.BytesIO(content_bytes)) as pdf:
                    for page in pdf.pages[:20]:
                        text = page.extract_text() or ""
                        pages.append(text)
                return "\n\n".join(pages)
            except ImportError:
                pass

        if mime_type.startswith("image/"):
            ext = mime_type.split("/")[-1]
            b64 = base64.b64encode(content_bytes).decode()
            return f"[image/{ext}] base64:{b64[:200]}..."

        return content_bytes.decode("utf-8", errors="replace")[:2000]

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def add_file(
        self,
        path: str,
        content_bytes: bytes,
        mime_type: str | None = None,
    ) -> bool:
        """Add or update a file in the vector store. Returns True on success."""
        tbl = self._get_or_create_table()
        if tbl is None:
            return False

        if mime_type is None:
            guessed, _ = mimetypes.guess_type(path)
            mime_type = guessed or "application/octet-stream"

        content_text = self._extract_text(content_bytes, mime_type)
        vector = self._embed(content_text[:1000])
        doc_id = self._file_id(path)

        try:
            try:
                tbl.delete(f"id = '{doc_id}'")
            except Exception:
                pass
            tbl.add([{
                "id": doc_id,
                "path": path,
                "mime_type": mime_type,
                "content_text": content_text[:4000],
                "vector": vector,
            }])
            return True
        except Exception:
            return False

    def search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """
        Semantic search over stored files.
        Returns list of {id, path, mime_type, content_text, score}.
        """
        tbl = self._get_or_create_table()
        if tbl is None:
            return []
        try:
            q_vec = self._embed(query)
            results = tbl.search(q_vec).limit(limit).to_list()
            return [
                {
                    "id": r.get("id"),
                    "path": r.get("path"),
                    "mime_type": r.get("mime_type"),
                    "content_text": r.get("content_text", "")[:500],
                    "score": r.get("_distance", 0.0),
                }
                for r in results
            ]
        except Exception:
            return []

    def delete(self, path: str) -> bool:
        """Delete a file by its original path."""
        tbl = self._get_or_create_table()
        if tbl is None:
            return False
        doc_id = self._file_id(path)
        try:
            tbl.delete(f"id = '{doc_id}'")
            return True
        except Exception:
            return False

    def list_files(self) -> list[dict[str, str]]:
        """List all indexed files (id, path, mime_type)."""
        tbl = self._get_or_create_table()
        if tbl is None:
            return []
        try:
            import pandas as pd  # type: ignore
            df = tbl.to_pandas()[["id", "path", "mime_type"]]
            return df.to_dict(orient="records")  # type: ignore[return-value]
        except Exception:
            return []
