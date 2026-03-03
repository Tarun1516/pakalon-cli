"""
phase_checkpoint.py — LangGraph phase checkpointing for crash recovery.
T1-7: Save phase state to disk so a partial run can be resumed without
      re-executing expensive earlier phases.

Usage::

    from utils.phase_checkpoint import PhaseCheckpoint, checkpoint_phase

    cp = PhaseCheckpoint(session_id="abc123")

    # Save state after a phase completes
    cp.save(phase_name="phase1", state=graph_state_dict)

    # Resume: check if a phase is already done
    if cp.is_complete("phase1"):
        state = cp.load("phase1")
    else:
        state = await run_phase1(...)
        cp.save("phase1", state)

    # Clean up when session is done
    cp.clear_all()
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Default checkpoint directory — $TMPDIR/pakalon-checkpoints/<session_id>/
_DEFAULT_BASE_DIR = Path(os.environ.get("TMPDIR", "/tmp")) / "pakalon-checkpoints"


class PhaseCheckpoint:
    """
    Manages checkpoint files for a single agent session.

    Checkpoints are stored as gzipped JSON files:
        <base_dir>/<session_id>/<phase_name>.ckpt.gz
    """

    def __init__(
        self,
        session_id: str,
        base_dir: Path | str | None = None,
        ttl_seconds: int = 3600 * 4,  # 4-hour expiry by default
    ) -> None:
        self.session_id = session_id
        self.base_dir = Path(base_dir or _DEFAULT_BASE_DIR)
        self.ttl_seconds = ttl_seconds
        self._dir = self.base_dir / session_id
        self._dir.mkdir(parents=True, exist_ok=True)

    # ─────────────────────────────────────────────────────────────────────────
    # Core operations
    # ─────────────────────────────────────────────────────────────────────────

    def _path(self, phase_name: str) -> Path:
        safe = phase_name.replace("/", "_").replace(" ", "_")
        return self._dir / f"{safe}.ckpt.gz"

    def save(self, phase_name: str, state: dict[str, Any]) -> None:
        """Persist phase state to disk (gzipped JSON)."""
        payload = {
            "session_id": self.session_id,
            "phase_name": phase_name,
            "saved_at": time.time(),
            "state": state,
        }
        data = json.dumps(payload, default=str).encode()
        p = self._path(phase_name)
        with gzip.open(p, "wb") as f:
            f.write(data)
        logger.debug("Checkpoint saved: %s / %s (%d bytes)", self.session_id, phase_name, len(data))

    def load(self, phase_name: str) -> Optional[dict[str, Any]]:
        """Load phase state from disk. Returns None if not found or expired."""
        p = self._path(phase_name)
        if not p.exists():
            return None

        try:
            with gzip.open(p, "rb") as f:
                payload = json.loads(f.read().decode())
        except Exception as exc:
            logger.warning("Failed to read checkpoint %s: %s", p, exc)
            return None

        # TTL check
        age = time.time() - payload.get("saved_at", 0)
        if age > self.ttl_seconds:
            logger.info("Checkpoint %s/%s expired (age %.0fs > ttl %ds)", self.session_id, phase_name, age, self.ttl_seconds)
            p.unlink(missing_ok=True)
            return None

        return payload.get("state")

    def is_complete(self, phase_name: str) -> bool:
        """Return True if a valid (non-expired) checkpoint exists for this phase."""
        return self.load(phase_name) is not None

    def invalidate(self, phase_name: str) -> bool:
        """Delete a specific phase checkpoint. Returns True if it existed."""
        p = self._path(phase_name)
        if p.exists():
            p.unlink()
            return True
        return False

    def clear_all(self) -> int:
        """Remove all checkpoints for this session. Returns number deleted."""
        count = 0
        for f in self._dir.glob("*.ckpt.gz"):
            f.unlink(missing_ok=True)
            count += 1
        try:
            self._dir.rmdir()  # Only succeeds if now empty
        except OSError:
            pass
        return count

    def list_phases(self) -> list[dict[str, Any]]:
        """List all saved checkpoints with their age and size."""
        result = []
        for f in sorted(self._dir.glob("*.ckpt.gz")):
            stat = f.stat()
            age = time.time() - stat.st_mtime
            result.append({
                "phase": f.stem.replace(".ckpt", ""),
                "file": str(f),
                "size_bytes": stat.st_size,
                "age_seconds": int(age),
                "expired": age > self.ttl_seconds,
            })
        return result

    # ─────────────────────────────────────────────────────────────────────────
    # Context manager for automatic cleanup on error
    # ─────────────────────────────────────────────────────────────────────────

    def __enter__(self) -> "PhaseCheckpoint":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is None:
            # Successful completion — clean up checkpoints
            self.clear_all()
        # On error — leave checkpoints so user can resume


# ─────────────────────────────────────────────────────────────────────────────
# Convenience decorator
# ─────────────────────────────────────────────────────────────────────────────

def checkpoint_phase(
    cp: PhaseCheckpoint,
    phase_name: str,
    *,
    force_rerun: bool = False,
) -> Any:
    """
    Decorator factory — wraps an async phase function with checkpoint
    load/save logic.

    Example::

        @checkpoint_phase(cp, "phase2")
        async def run_phase2(state: dict) -> dict:
            ...

        # On second call, returns cached result immediately
        result = await run_phase2(state)
    """
    from functools import wraps

    def decorator(fn: Any) -> Any:
        @wraps(fn)
        async def wrapper(state: dict, *args: Any, **kwargs: Any) -> Any:
            if not force_rerun and cp.is_complete(phase_name):
                cached = cp.load(phase_name)
                logger.info("Resuming %s from checkpoint (skipping re-execution)", phase_name)
                return cached

            result = await fn(state, *args, **kwargs)
            if isinstance(result, dict):
                cp.save(phase_name, result)
            return result

        return wrapper

    return decorator


# ─────────────────────────────────────────────────────────────────────────────
# Global checkpoint registry (keyed by session_id)
# ─────────────────────────────────────────────────────────────────────────────

_REGISTRY: dict[str, PhaseCheckpoint] = {}


def get_checkpoint(session_id: str, **kwargs: Any) -> PhaseCheckpoint:
    """Get-or-create a PhaseCheckpoint for a session."""
    if session_id not in _REGISTRY:
        _REGISTRY[session_id] = PhaseCheckpoint(session_id, **kwargs)
    return _REGISTRY[session_id]


def purge_expired_checkpoints(base_dir: Path | str | None = None) -> int:
    """
    Scan all checkpoint directories and delete expired entries.
    Useful to call on startup or in a scheduled job.
    Returns total number of files deleted.
    """
    base = Path(base_dir or _DEFAULT_BASE_DIR)
    if not base.exists():
        return 0

    total = 0
    for session_dir in base.iterdir():
        if not session_dir.is_dir():
            continue
        cp = PhaseCheckpoint(session_dir.name, base_dir=base)
        for entry in cp.list_phases():
            if entry["expired"]:
                cp.invalidate(entry["phase"])
                total += 1

    return total
