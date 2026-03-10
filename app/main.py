"""Compatibility shim for ``uvicorn app.main:app`` from the CLI directory."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


_backend_root = Path(__file__).resolve().parents[2] / "pakalon-backend"
_backend_main = _backend_root / "app" / "main.py"

if not _backend_main.exists():
    raise ModuleNotFoundError(
        f"Could not find backend application at {_backend_main}. "
        "Start the command from pakalon-backend or restore the backend app files."
    )

if str(_backend_root) not in sys.path:
    sys.path.insert(0, str(_backend_root))

_spec = importlib.util.spec_from_file_location("_pakalon_backend_main", _backend_main)
if _spec is None or _spec.loader is None:
    raise ImportError(f"Could not load backend application module from {_backend_main}")

_module = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("_pakalon_backend_main", _module)
_spec.loader.exec_module(_module)


def __getattr__(name: str):
    return getattr(_module, name)


app = _module.app
create_app = _module.create_app
lifespan = getattr(_module, "lifespan", None)
