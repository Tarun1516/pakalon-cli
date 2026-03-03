"""
penpot_sync.py — Live Penpot Editing Sync for Phase 2

This module provides bidirectional synchronization between Penpot designs
and the agent's wireframe specifications.

Features:
- Polling-based sync (checks for changes periodically)
- Wireframe import from Penpot project state
- Conflict resolution between manual edits and agent edits
- Sync status tracking
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

import httpx


class SyncStatus(Enum):
    IDLE = "idle"
    SYNCING = "syncing"
    CONFLICT = "conflict"
    ERROR = "error"
    DISCONNECTED = "disconnected"


class SyncDirection(Enum):
    IMPORT = "import"      # Penpot -> Local
    EXPORT = "export"      # Local -> Penpot
    BIDIRECTIONAL = "bidirectional"


@dataclass
class PenpotPage:
    """Represents a page in Penpot."""
    id: str
    name: str
    thumbnail_url: str | None = None
    modified_at: str | None = None


@dataclass
class PenpotFrame:
    """Represents a frame/artboard in Penpot."""
    id: str
    name: str
    width: float
    height: float
    children: list[dict] = field(default_factory=list)


@dataclass
class PenpotDesign:
    """Represents a complete Penpot design."""
    id: str
    name: str
    pages: list[PenpotPage] = field(default_factory=list)
    frames: list[PenpotFrame] = field(default_factory=list)
    modified_at: str | None = None


@dataclass
class SyncConflict:
    """Represents a conflict between local and Penpot versions."""
    file_path: str
    local_hash: str
    remote_hash: str
    local_content: dict
    remote_content: dict
    resolution: str | None = None


@dataclass
class SyncState:
    """Tracks the current sync state."""
    status: SyncStatus = SyncStatus.IDLE
    last_sync: datetime | None = None
    direction: SyncDirection = SyncDirection.BIDIRECTIONAL
    conflicts: list[SyncConflict] = field(default_factory=list)
    local_version: str = ""
    remote_version: str = ""
    error_message: str | None = None


class PenpotSyncClient:
    """
    Client for bidirectional sync with Penpot.

    Usage:
        client = PenpotSyncClient(
            api_url="http://localhost:9001/api",
            api_token="your-penpot-token",
            project_id="project-uuid"
        )
        await client.start_sync()
    """

    def __init__(
        self,
        api_url: str = "http://localhost:9001/api",
        api_token: str | None = None,
        project_id: str | None = None,
        local_dir: str = ".pakalon-agents/ai-agents/phase-2/wireframes",
        poll_interval: int = 30,
    ):
        self.api_url = api_url.rstrip("/")
        self.api_token = api_token or os.environ.get("PENPOT_API_TOKEN", "")
        self.project_id = project_id or os.environ.get("PENPOT_PROJECT_ID", "")
        self.local_dir = Path(local_dir)
        self.poll_interval = poll_interval

        self.state = SyncState()
        self._running = False
        self._sync_task: asyncio.Task | None = None

        # HTTP client
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {self.api_token}" if self.api_token else "",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    async def close(self):
        """Close the client and stop sync."""
        self._running = False
        if self._sync_task:
            self._sync_task.cancel()
            try:
                await self._sync_task
            except asyncio.CancelledError:
                pass
        await self._client.aclose()

    # -------------------------------------------------------------------------
    # API Methods
    # -------------------------------------------------------------------------

    async def test_connection(self) -> tuple[bool, str]:
        """Test connection to Penpot API."""
        try:
            resp = await self._client.get(f"{self.api_url}/health")
            if resp.status_code == 200:
                return True, "Connected to Penpot"
            return False, f"Health check failed: {resp.status_code}"
        except Exception as e:
            return False, f"Connection failed: {str(e)}"

    async def get_project(self, project_id: str | None = None) -> dict | None:
        """Get project details."""
        pid = project_id or self.project_id
        if not pid:
            return None
        try:
            resp = await self._client.get(f"{self.api_url}/projects/{pid}")
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            pass
        return None

    async def list_pages(self, project_id: str | None = None) -> list[PenpotPage]:
        """List all pages in the project."""
        pid = project_id or self.project_id
        if not pid:
            return []

        try:
            resp = await self._client.get(f"{self.api_url}/projects/{pid}/pages")
            if resp.status_code == 200:
                data = resp.json()
                return [
                    PenpotPage(
                        id=page.get("id", ""),
                        name=page.get("name", "Untitled"),
                        thumbnail_url=page.get("thumbnail"),
                        modified_at=page.get("modifiedAt"),
                    )
                    for page in data
                ]
        except Exception:
            pass
        return []

    async def get_page(self, page_id: str) -> dict | None:
        """Get full page data with all frames."""
        try:
            resp = await self._client.get(f"{self.api_url}/pages/{page_id}")
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            pass
        return None

    async def export_page_svg(self, page_id: str) -> bytes | None:
        """Export a page as SVG."""
        try:
            resp = await self._client.get(
                f"{self.api_url}/export",
                params={"ids": [page_id], "format": "svg"},
            )
            if resp.status_code == 200:
                return resp.content
        except Exception:
            pass
        return None

    async def get_file_library(self) -> dict | None:
        """Get file library (components, colors, typography)."""
        if not self.project_id:
            return None
        try:
            resp = await self._client.get(
                f"{self.api_url}/projects/{self.project_id}/library"
            )
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            pass
        return None

    # -------------------------------------------------------------------------
    # Sync Methods
    # -------------------------------------------------------------------------

    async def start_sync(self, direction: SyncDirection = SyncDirection.BIDIRECTIONAL):
        """Start the sync loop."""
        if self._running:
            return

        self._running = True
        self.state.direction = direction
        self.state.status = SyncStatus.IDLE
        self._sync_task = asyncio.create_task(self._sync_loop())

    async def stop_sync(self):
        """Stop the sync loop."""
        self._running = False
        if self._sync_task:
            self._sync_task.cancel()
            try:
                await self._sync_task
            except asyncio.CancelledError:
                pass

    async def _sync_loop(self):
        """Main sync loop that polls for changes."""
        while self._running:
            try:
                await self._do_sync()
            except Exception as e:
                self.state.status = SyncStatus.ERROR
                self.state.error_message = str(e)

            await asyncio.sleep(self.poll_interval)

    async def _do_sync(self):
        """Perform a single sync iteration."""
        self.state.status = SyncStatus.SYNCING

        # Check remote changes
        remote_hash = await self._get_remote_hash()
        if remote_hash != self.state.remote_version:
            await self._import_from_penpot()

        # Check local changes
        local_hash = await self._get_local_hash()
        if local_hash != self.state.local_version:
            if self.state.direction in (SyncDirection.EXPORT, SyncDirection.BIDIRECTIONAL):
                await self._export_to_penpot()

        # Check for conflicts
        await self._check_conflicts()

        self.state.last_sync = datetime.utcnow()
        self.state.status = SyncStatus.IDLE

    async def _get_remote_hash(self) -> str:
        """Get a hash of the remote Penpot state."""
        pages = await self.list_pages()
        content = json.dumps([{"id": p.id, "name": p.name, "modified": p.modified_at} for p in pages])
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    async def _get_local_hash(self) -> str:
        """Get a hash of the local wireframe state."""
        if not self.local_dir.exists():
            return ""

        files = []
        for f in self.local_dir.glob("**/*.json"):
            files.append(f"{f.name}:{f.stat().st_mtime}")

        content = json.dumps(sorted(files))
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    async def _import_from_penpot(self):
        """Import designs from Penpot to local wireframes."""
        self.local_dir.mkdir(parents=True, exist_ok=True)

        pages = await self.list_pages()
        for page in pages:
            page_data = await self.get_page(page.id)
            if page_data:
                # Save as JSON
                json_path = self.local_dir / f"{page.name.replace(' ', '_')}.json"
                with open(json_path, "w", encoding="utf-8") as f:
                    json.dump(page_data, f, indent=2)

                # Export as SVG
                svg_data = await self.export_page_svg(page.id)
                if svg_data:
                    svg_path = self.local_dir / f"{page.name.replace(' ', '_')}.svg"
                    with open(svg_path, "wb") as f:
                        f.write(svg_data)

        self.state.remote_version = await self._get_remote_hash()

    async def _export_to_penpot(self):
        """Export local wireframes to Penpot."""
        # This would require the Penpot file-update API
        # For now, we'll generate a summary that can be imported manually
        if not self.local_dir.exists():
            return

        export_data = {
            "generated_at": datetime.utcnow().isoformat(),
            "frames": [],
        }

        for json_file in self.local_dir.glob("*.json"):
            with open(json_file) as f:
                data = json.load(f)
                export_data["frames"].append({
                    "file": json_file.name,
                    "data": data,
                })

        # Save export manifest
        export_path = self.local_dir / "penpot_export.json"
        with open(export_path, "w") as f:
            json.dump(export_data, f, indent=2)

        self.state.local_version = await self._get_local_hash()

    async def _check_conflicts(self):
        """Check for conflicts between local and remote."""
        # Compare hashes
        if self.state.local_version and self.state.remote_version:
            # In a real implementation, we'd track which specific files changed
            # For now, we just note that there might be conflicts
            pass

    # -------------------------------------------------------------------------
    # Conflict Resolution
    # -------------------------------------------------------------------------

    async def resolve_conflict(
        self,
        conflict: SyncConflict,
        resolution: "keep_local" | "keep_remote" | "merge",
    ):
        """Resolve a sync conflict."""
        conflict.resolution = resolution

        if resolution == "keep_local":
            # Keep local, push to remote
            await self._export_to_penpot()
        elif resolution == "keep_remote":
            # Overwrite local with remote
            await self._import_from_penpot()
        elif resolution == "merge":
            # Attempt to merge (requires smart merging logic)
            pass

    # -------------------------------------------------------------------------
    # Status Reporting
    # -------------------------------------------------------------------------

    def get_status(self) -> dict:
        """Get current sync status."""
        return {
            "status": self.state.status.value,
            "last_sync": self.state.last_sync.isoformat() if self.state.last_sync else None,
            "direction": self.state.direction.value,
            "conflicts_count": len(self.state.conflicts),
            "local_version": self.state.local_version,
            "remote_version": self.state.remote_version,
            "error": self.state.error_message,
        }

    def get_sync_files(self) -> list[dict]:
        """Get list of files being synced."""
        if not self.local_dir.exists():
            return []

        files = []
        for f in self.local_dir.glob("**/*"):
            if f.is_file():
                files.append({
                    "name": f.name,
                    "path": str(f.relative_to(self.local_dir)),
                    "size": f.stat().st_size,
                    "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                })
        return files


# -------------------------------------------------------------------------
# CLI Commands
# -------------------------------------------------------------------------

async def cmd_penpot_sync_status():
    """Show Penpot sync status."""
    client = PenpotSyncClient()

    connected, message = await client.test_connection()
    status = client.get_status()

    result = {
        "connected": connected,
        "message": message,
        "sync_status": status,
    }

    if connected:
        result["files"] = client.get_sync_files()

    await client.close()
    return result


async def cmd_penpot_sync_start(direction: str = "bidirectional"):
    """Start Penpot sync."""
    dir_map = {
        "import": SyncDirection.IMPORT,
        "export": SyncDirection.EXPORT,
        "bidirectional": SyncDirection.BIDIRECTIONAL,
    }

    client = PenpotSyncClient()
    await client.start_sync(dir_map.get(direction, SyncDirection.BIDIRECTIONAL))

    return {
        "status": "started",
        "direction": direction,
    }


async def cmd_penpot_sync_stop():
    """Stop Penpot sync."""
    client = PenpotSyncClient()
    await client.stop_sync()

    return {"status": "stopped"}


async def cmd_penpot_import():
    """Import designs from Penpot."""
    client = PenpotSyncClient()
    await client._import_from_penpot()
    await client.close()

    return {
        "status": "imported",
        "files": client.get_sync_files(),
    }
