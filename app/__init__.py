"""Compatibility package for running the backend from the CLI directory.

This lets commands like:

    uv run uvicorn app.main:app --reload --port 8000

work even when they are launched from ``d:\\pakalon\\pakalon-cli``.
The package path is extended to include ``../pakalon-backend/app`` so imports
such as ``app.config`` and ``app.routers`` still resolve to the real backend.
"""

from __future__ import annotations

from pathlib import Path

_backend_app_dir = Path(__file__).resolve().parents[2] / "pakalon-backend" / "app"

if _backend_app_dir.exists():
    __path__.append(str(_backend_app_dir))
