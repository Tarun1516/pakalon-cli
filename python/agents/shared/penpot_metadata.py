"""
Canonical project-scoped Penpot metadata helpers.

This module keeps a single source of truth for the current Penpot design at:
  <project_dir>/.pakalon/penpot.json

Legacy phase-2 manifests are still written for backward compatibility so older
CLI and phase code can continue to function while the canonical metadata file
becomes the primary contract.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def _default_base_url() -> str:
    return (
        os.environ.get("PENPOT_BASE_URL")
        or os.environ.get("PENPOT_HOST")
        or "http://localhost:3449"
    ).rstrip("/")


def get_penpot_metadata_path(project_dir: str | Path, create: bool = True) -> Path:
    base = Path(project_dir) / ".pakalon"
    if create:
        base.mkdir(parents=True, exist_ok=True)
    return base / "penpot.json"


def get_phase2_penpot_dir(project_dir: str | Path, create: bool = True) -> Path:
    base = Path(project_dir) / ".pakalon-agents" / "ai-agents" / "phase-2"
    if create:
        base.mkdir(parents=True, exist_ok=True)
    return base


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return None


def _coalesce(raw: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in raw and raw[key] not in (None, ""):
            return raw[key]
    return None


def _extract_ids_from_url(url: str | None) -> tuple[str | None, str | None]:
    if not url:
        return None, None
    try:
        parsed = urlparse(url)
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 3 and parts[0] == "view":
            return parts[1], parts[2]
        if len(parts) >= 2 and parts[0] == "view":
            return None, parts[1]
    except Exception:
        return None, None
    return None, None


def _build_urls(
    base_url: str,
    file_id: str | None,
    project_id: str | None,
    project_url: str | None,
    file_url: str | None,
) -> tuple[str | None, str | None]:
    if project_url:
        _, inferred_file_id = _extract_ids_from_url(project_url)
        if not file_id:
            file_id = inferred_file_id
    if not project_url and file_id and project_id:
        project_url = f"{base_url}/view/{project_id}/{file_id}"
    if not file_url and file_id:
        file_url = project_url or f"{base_url}/view/{file_id}"
    return project_url, file_url


def normalize_penpot_metadata(raw: dict[str, Any], project_dir: str | Path | None = None) -> dict[str, Any]:
    base_url = str(_coalesce(raw, "base_url", "baseUrl", "penpot_base_url") or _default_base_url()).rstrip("/")
    project_url = _coalesce(raw, "project_url", "projectUrl", "penpot_project_url")
    file_url = _coalesce(raw, "file_url", "fileUrl", "penpot_file_url")
    project_id = _coalesce(raw, "project_id", "projectId", "penpot_project_id")
    file_id = _coalesce(raw, "file_id", "fileId", "penpot_file_id")

    extracted_project_id, extracted_file_id = _extract_ids_from_url(str(project_url) if project_url else None)
    project_id = str(project_id or extracted_project_id) if (project_id or extracted_project_id) else None
    file_id = str(file_id or extracted_file_id) if (file_id or extracted_file_id) else None

    project_url, file_url = _build_urls(base_url, file_id, project_id, project_url, file_url)

    local_svg_path = _coalesce(
        raw,
        "local_svg_path",
        "localSvgPath",
        "wireframe_svg_path",
        "wireframeSvgPath",
    )
    local_json_path = _coalesce(
        raw,
        "local_json_path",
        "localJsonPath",
        "wireframe_json_path",
        "wireframeJsonPath",
    )

    normalized: dict[str, Any] = {
        "version": int(_coalesce(raw, "version") or 1),
        "base_url": base_url,
        "file_id": file_id,
        "project_id": project_id,
        "project_url": project_url,
        "file_url": file_url,
        "revision": _coalesce(raw, "revision", "revn", "penpot_revn"),
        "phase": _coalesce(raw, "phase", "source_phase") or 2,
        "status": _coalesce(raw, "status") or "ready",
        "source": _coalesce(raw, "source") or "unknown",
        "updated_at": _coalesce(raw, "updated_at", "updatedAt") or None,
        "local_svg_path": str(local_svg_path) if local_svg_path else None,
        "local_json_path": str(local_json_path) if local_json_path else None,
    }

    if project_dir is not None:
        normalized["project_dir"] = str(Path(project_dir).resolve())

    return normalized


def read_penpot_metadata(project_dir: str | Path) -> dict[str, Any] | None:
    project_dir = Path(project_dir)
    candidates = [
        get_penpot_metadata_path(project_dir, create=False),
        get_phase2_penpot_dir(project_dir, create=False) / "phase-2-manifest.json",
        get_phase2_penpot_dir(project_dir, create=False) / "url-manifest.json",
        get_phase2_penpot_dir(project_dir, create=False) / "penpot_meta.json",
    ]
    for candidate in candidates:
        raw = _read_json(candidate)
        if raw:
            normalized = normalize_penpot_metadata(raw, project_dir)
            normalized["source_file"] = str(candidate)
            return normalized
    return None


def write_penpot_metadata(project_dir: str | Path, metadata: dict[str, Any]) -> dict[str, Any]:
    current = read_penpot_metadata(project_dir) or {}
    merged = normalize_penpot_metadata({**current, **metadata}, project_dir)
    path = get_penpot_metadata_path(project_dir, create=True)
    path.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    return merged


def sync_penpot_artifacts(project_dir: str | Path, metadata: dict[str, Any]) -> dict[str, Any]:
    canonical = write_penpot_metadata(project_dir, metadata)
    phase2_dir = get_phase2_penpot_dir(project_dir, create=True)

    phase2_manifest = {
        "penpot_file_id": canonical.get("file_id"),
        "penpot_project_id": canonical.get("project_id"),
        "penpot_project_url": canonical.get("project_url"),
        "penpot_file_url": canonical.get("file_url"),
        "penpot_revn": canonical.get("revision"),
        "penpot_base_url": canonical.get("base_url"),
        "updated_at": canonical.get("updated_at"),
        "status": canonical.get("status"),
        "phase": canonical.get("phase"),
        "source": canonical.get("source"),
    }
    phase2_manifest_path = phase2_dir / "phase-2-manifest.json"
    phase2_manifest_path.write_text(json.dumps(phase2_manifest, indent=2), encoding="utf-8")

    url_manifest = {
        "penpot_project_url": canonical.get("project_url"),
        "penpot_file_id": canonical.get("file_id"),
        "penpot_file_url": canonical.get("file_url"),
        "penpot_project_id": canonical.get("project_id"),
        "penpot_revn": canonical.get("revision"),
        "updated_at": canonical.get("updated_at"),
    }
    url_manifest_path = phase2_dir / "url-manifest.json"
    url_manifest_path.write_text(json.dumps(url_manifest, indent=2), encoding="utf-8")

    legacy_meta = {
        "fileId": canonical.get("file_id"),
        "projectId": canonical.get("project_id"),
        "projectUrl": canonical.get("project_url"),
        "fileUrl": canonical.get("file_url"),
        "revn": canonical.get("revision"),
        "baseUrl": canonical.get("base_url"),
        "updatedAt": canonical.get("updated_at"),
    }
    legacy_meta_path = phase2_dir / "penpot_meta.json"
    legacy_meta_path.write_text(json.dumps(legacy_meta, indent=2), encoding="utf-8")

    return {
        "metadata": canonical,
        "paths": {
            "canonical": str(get_penpot_metadata_path(project_dir, create=False)),
            "phase2_manifest": str(phase2_manifest_path),
            "url_manifest": str(url_manifest_path),
            "legacy_meta": str(legacy_meta_path),
        },
    }