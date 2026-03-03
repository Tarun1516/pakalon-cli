"""
penpot.py — Penpot wireframe generation tool for Pakalon agents.
T099: PenpotTool via Penpot v2.11.1 REST API (Docker container).

Auth notes:
  Penpot uses session-cookie auth, NOT bearer tokens for its own API.
  The flow is:
    1. POST /api/rpc/command/login-with-password  → Set-Cookie: auth-token
    2. All subsequent requests carry that cookie automatically.
  Alternatively an Access Token can be obtained from the Penpot UI and
  passed via the Authorization header as a raw hex string (no "Bearer" prefix).
  We support both: cookie-based via PENPOT_EMAIL + PENPOT_PASSWORD, and
  token-based via PENPOT_ACCESS_TOKEN.
"""
from __future__ import annotations

import json
import os
import subprocess
import uuid as _uuid_mod
from typing import Any

import httpx

PENPOT_BASE = os.environ.get("PENPOT_BASE_URL", "http://localhost:3449")
# Legacy env var — kept for back-compat, but prefer PENPOT_EMAIL/PASSWORD
PENPOT_TOKEN = os.environ.get("PENPOT_API_TOKEN", "")
# Penpot personal access token (hex, no "Bearer" prefix needed)
PENPOT_ACCESS_TOKEN = os.environ.get("PENPOT_ACCESS_TOKEN", PENPOT_TOKEN)
PENPOT_EMAIL = os.environ.get("PENPOT_EMAIL", "")
PENPOT_PASSWORD = os.environ.get("PENPOT_PASSWORD", "")
PENPOT_IMAGE = "penpotapp/frontend:2.11.1"
PENPOT_CONTAINER = "pakalon-penpot"

# Friendly → Penpot internal field name mapping for element patches
_PATCH_KEY_MAP: dict[str, str] = {
    "fill_color": "fill-color",
    "fill_opacity": "fill-opacity",
    "stroke_color": "stroke-color",
    "stroke_width": "stroke-width",
    "stroke_position": "stroke-position",
    "font_size": "font-size",
    "font_family": "font-family",
    "font_weight": "font-weight",
    "border_radius": "rx",
    "constraints_h": "constraints-h",
    "constraints_v": "constraints-v",
    "blend_mode": "blend-mode",
    "shadow": "shadow",
    "blur": "blur",
}


class PenpotTool:
    """
    Penpot wireframe generation via REST API.
    Manages the Docker container lifecycle.
    """

    def __init__(
        self,
        base_url: str = PENPOT_BASE,
        token: str = PENPOT_ACCESS_TOKEN,
        email: str = PENPOT_EMAIL,
        password: str = PENPOT_PASSWORD,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._email = email
        self._password = password
        # httpx.Client that persists cookies across calls
        self._session: httpx.Client | None = None
        # Cache the profile/team_id so we don't re-auth on every call
        self._team_id: str | None = None
        self._profile: dict[str, Any] | None = None

    # ------------------------------------------------------------------
    # Session / auth helpers
    # ------------------------------------------------------------------

    def _get_session(self) -> httpx.Client:
        """Return (and lazily create) the persistent httpx.Client session."""
        if self._session is None or self._session.is_closed:
            headers: dict[str, str] = {"Content-Type": "application/json"}
            if self._token:
                # Penpot personal access tokens are passed as the full auth
                # token value with *no* "Bearer" prefix.
                headers["Authorization"] = f"Token {self._token}"
            self._session = httpx.Client(
                headers=headers,
                timeout=30.0,
                follow_redirects=True,
            )
            # Cookie-based auth (preferred when email+password provided)
            if self._email and self._password and not self._token:
                self._login_with_password(self._session)
        return self._session

    def _login_with_password(self, client: httpx.Client) -> None:
        """
        Authenticate via email/password and store the session cookie.
        Raises httpx.HTTPStatusError on failure.
        """
        resp = client.post(
            f"{self._base}/api/rpc/command/login-with-password",
            json={"email": self._email, "password": self._password},
        )
        resp.raise_for_status()

    def _get_default_team_id(self) -> str:
        """
        Fetch the authenticated user's default team id.
        Caches the result in self._team_id.
        """
        if self._team_id:
            return self._team_id
        client = self._get_session()
        resp = client.get(f"{self._base}/api/rpc/command/get-profile")
        resp.raise_for_status()
        profile = resp.json()
        self._profile = profile
        # The default team is the user's personal team
        self._team_id = profile.get("default-team-id") or profile.get("defaultTeamId", "")
        return self._team_id  # type: ignore[return-value]

    @property
    def _headers(self) -> dict[str, str]:
        """Auth headers for one-shot requests (where session cookies aren't used)."""
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._token:
            h["Authorization"] = f"Token {self._token}"
        return h

    # ------------------------------------------------------------------
    # Container management
    # ------------------------------------------------------------------

    def is_running(self) -> bool:
        """Check if Penpot Docker container is running."""
        try:
            result = subprocess.run(
                ["docker", "inspect", "--format", "{{.State.Running}}", PENPOT_CONTAINER],
                capture_output=True, text=True, timeout=5,
            )
            return result.stdout.strip() == "true"
        except Exception:
            return False

    def start_container(self) -> bool:
        """Pull + start Penpot Docker container. Returns True on success."""
        try:
            # Check if container exists
            result = subprocess.run(
                ["docker", "ps", "-a", "--filter", f"name={PENPOT_CONTAINER}", "--format", "{{.Names}}"],
                capture_output=True, text=True, timeout=10,
            )
            if PENPOT_CONTAINER not in result.stdout:
                # Run fresh container
                subprocess.run(
                    [
                        "docker", "run", "-d",
                        "--name", PENPOT_CONTAINER,
                        "-p", "3449:80",
                        PENPOT_IMAGE,
                    ],
                    check=True, timeout=120,
                )
            else:
                subprocess.run(["docker", "start", PENPOT_CONTAINER], check=True, timeout=30)
            return True
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Core API operations
    # ------------------------------------------------------------------

    #: ID of the last file successfully created on Penpot, or None if unavailable.
    last_file_id: str | None = None
    #: Browseable Penpot URL for the last created file.
    last_project_url: str | None = None

    def create_project(self, name: str) -> str | None:
        """
        Create a new Penpot project in the user's default team.

        Returns the project id, or None on failure.
        Penpot API: POST /api/rpc/command/create-project
        Required params: team-id, name
        """
        try:
            team_id = self._get_default_team_id()
            client = self._get_session()
            resp = client.post(
                f"{self._base}/api/rpc/command/create-project",
                json={"team-id": team_id, "name": name},
            )
            resp.raise_for_status()
            return resp.json().get("id")
        except Exception:
            return None

    def create_file(self, project_id: str, name: str) -> dict[str, Any] | None:
        """
        Create a new Penpot file inside *project_id*.

        Returns the full file response dict including:
          id, name, project-id, revn, created-at
        Penpot API: POST /api/rpc/command/create-file
        Required params: project-id, name, is-shared
        """
        try:
            client = self._get_session()
            resp = client.post(
                f"{self._base}/api/rpc/command/create-file",
                json={
                    "project-id": project_id,
                    "name": name,
                    "is-shared": False,
                    "components-v2": True,
                },
            )
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return None

    def create_wireframe(self, design_spec: dict[str, Any] | str) -> str:
        """
        Generate a wireframe from a design spec.

        Returns SVG string representing the wireframe.
        design_spec: dict with keys: title, pages, components, colors, fonts.

        After a successful Penpot API call:
          self.last_file_id   → Penpot file UUID
          self.last_project_url → browseable URL (http://localhost:3449/...)
        """
        if isinstance(design_spec, str):
            try:
                design_spec = json.loads(design_spec)
            except json.JSONDecodeError:
                design_spec = {"description": design_spec}

        # Fallback: local SVG generation when Penpot Docker not running
        if not self.is_running():
            return self._generate_svg_wireframe(design_spec)

        try:
            title = design_spec.get("title", "Pakalon Wireframe")

            # Step 1: Create or reuse a project
            project_id = self.create_project(f"Pakalon — {title}")
            if not project_id:
                return self._generate_svg_wireframe(design_spec)

            # Step 2: Create the file inside that project
            file_data = self.create_file(project_id, title)
            if not file_data:
                return self._generate_svg_wireframe(design_spec)
            file_id: str = file_data["id"]
            revn: int = file_data.get("revn", 0)

            # Step 3: Build and apply all shape changes (pages + elements)
            client = self._get_session()
            changes = self._spec_to_changes(design_spec)
            if changes:
                update_resp = client.post(
                    f"{self._base}/api/rpc/command/update-file",
                    json={
                        "id": file_id,
                        "revn": revn,
                        "components-v2": True,
                        "changes": changes,
                    },
                )
                update_resp.raise_for_status()

            # Step 4: Export as SVG for local preview
            svg = self.export_svg(file_id)

            # Step 5: Build and cache the browseable project URL
            self.last_file_id = file_id
            self.last_project_url = (
                f"{self._base}/view/{project_id}/{file_id}"
            )
            return svg

        except Exception:
            return self._generate_svg_wireframe(design_spec)

    def add_page(self, file_id: str, page_name: str) -> str | None:
        """
        Add a page to an existing file. Returns page id or None on failure.
        Penpot API: POST /api/rpc/command/create-page
        Required params: file-id, name
        """
        try:
            client = self._get_session()
            resp = client.post(
                f"{self._base}/api/rpc/command/create-page",
                json={"file-id": file_id, "name": page_name},
            )
            resp.raise_for_status()
            return resp.json().get("id")
        except Exception:
            return None

    def export_svg(self, file_id: str) -> str:
        """Export a file as SVG (first page / thumbnail)."""
        try:
            client = self._get_session()
            resp = client.get(
                f"{self._base}/api/rpc/command/export-file-object",
                params={"file-id": file_id, "type": "svg"},
            )
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            return f"<!-- Export failed: {e} -->"

    def export_json(self, file_id: str) -> dict[str, Any]:
        """Export a file as JSON (transit format → parsed)."""
        try:
            client = self._get_session()
            resp = client.get(
                f"{self._base}/api/rpc/command/get-file",
                params={"id": file_id, "components-v2": "true"},
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Bidirectional element editing (D-03 / T-P2-EDIT)
    # ------------------------------------------------------------------

    def get_file_meta(self, file_id: str) -> dict[str, Any]:
        """
        Fetch the full file metadata including revision number.
        Returns dict with: id, name, revn, pages, etc.
        """
        try:
            client = self._get_session()
            resp = client.get(
                f"{self._base}/api/rpc/command/get-file",
                params={"id": file_id, "components-v2": "true"},
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            return {"error": str(e)}

    def get_pages(self, file_id: str) -> list[dict[str, Any]]:
        """
        Return all pages in a Penpot file.
        Each page has: id, name, objects (dict of element_id → element).
        """
        meta = self.get_file_meta(file_id)
        if "error" in meta:
            return []
        data = meta.get("data", meta)
        pages_index = data.get("pages-index", {})
        return [
            {"id": pid, **page_data}
            for pid, page_data in pages_index.items()
        ]

    def get_elements(self, file_id: str, page_id: str | None = None) -> list[dict[str, Any]]:
        """
        Return all elements/shapes in a file (or a specific page).

        Each element dict includes:
          - id: element UUID
          - type: "rect" | "text" | "frame" | "group" | "circle" | "path" | ...
          - name: display name
          - x, y, width, height: geometry
          - fill, stroke, opacity: styling
          - content: text content (for type="text")

        Args:
            file_id:  Penpot file id.
            page_id:  If given, only return elements from that page.
                      If None, returns elements from all pages.

        Returns list of element dicts.
        """
        pages = self.get_pages(file_id)
        elements: list[dict[str, Any]] = []
        for page in pages:
            if page_id and page.get("id") != page_id:
                continue
            objects = page.get("objects", {})
            for eid, obj in objects.items():
                # Skip the root frame (id == page id)
                if eid == page.get("id"):
                    continue
                elements.append({
                    "id": eid,
                    "page_id": page.get("id"),
                    "page_name": page.get("name", ""),
                    "type": obj.get("type", "unknown"),
                    "name": obj.get("name", ""),
                    "x": obj.get("x", 0),
                    "y": obj.get("y", 0),
                    "width": obj.get("width", 0),
                    "height": obj.get("height", 0),
                    "opacity": obj.get("opacity", 1),
                    "fills": obj.get("fills", []),
                    "strokes": obj.get("strokes", []),
                    "content": obj.get("content", None),
                    "raw": obj,
                })
        return elements

    def update_element(
        self,
        file_id: str,
        element_id: str,
        patches: dict[str, Any],
        page_id: str | None = None,
        current_revn: int = 0,
    ) -> dict[str, Any]:
        """
        Apply attribute patches to a single element in-place.

        Supported patch keys (subset of Penpot shape fields):
          x, y, width, height, opacity, name,
          fills (list of fill dicts),
          strokes (list of stroke dicts),
          content (text content string for text elements),
          rotation, rx, ry (border radius),
          constraints-h, constraints-v.

        Args:
            file_id:     Penpot file id.
            element_id:  UUID of the element to update.
            patches:     Dict of {field: new_value} to apply.
            page_id:     Page that contains the element. Auto-detected if None.
            current_revn: Current file revision (0 = fetch latest automatically).

        Returns:
            {"ok": True, "revn": <new revn>} on success,
            {"ok": False, "error": "..."} on failure.
        """
        # Auto-detect page_id
        if page_id is None:
            for el in self.get_elements(file_id):
                if el["id"] == element_id:
                    page_id = el["page_id"]
                    break
        if not page_id:
            return {"ok": False, "error": f"Element {element_id!r} not found in file {file_id!r}"}

        # Auto-fetch revn if not supplied
        if current_revn == 0:
            meta = self.get_file_meta(file_id)
            current_revn = meta.get("revn", 0)

        # Build Penpot change operation: mod-obj
        operations: list[dict[str, Any]] = []
        for key, val in patches.items():
            # Map friendly names to Penpot internal names where needed
            penpot_key = _PATCH_KEY_MAP.get(key, key)
            operations.append({"type": "set", "attr": penpot_key, "val": val})

        change = {
            "type": "mod-obj",
            "page-id": page_id,
            "id": element_id,
            "operations": operations,
        }

        try:
            client = self._get_session()
            resp = client.post(
                f"{self._base}/api/rpc/command/update-file",
                json={
                    "id": file_id,
                    "revn": current_revn,
                    "components-v2": True,
                    "changes": [change],
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return {"ok": True, "revn": data.get("revn", current_revn + 1), "element_id": element_id}
        except Exception as e:
            return {"ok": False, "error": str(e), "element_id": element_id}

    def apply_element_patches(
        self,
        file_id: str,
        patches_list: list[dict[str, Any]],
        current_revn: int = 0,
    ) -> dict[str, Any]:
        """
        Batch-apply patches to multiple elements in a single API call.

        Args:
            file_id:      Penpot file id.
            patches_list: List of patch dicts, each with:
                          {
                            "element_id": "<uuid>",
                            "page_id": "<uuid>",   # optional — auto-detected
                            "patches": { ... }     # same as update_element patches arg
                          }
            current_revn: Current file revision (0 = auto-fetch).

        Returns:
            {"ok": True, "revn": ..., "applied": N} on success,
            {"ok": False, "error": "...", "partial": [...]} on failure.
        """
        if not patches_list:
            return {"ok": True, "revn": current_revn, "applied": 0}

        # Auto-detect page IDs for any element missing them
        if any(not p.get("page_id") for p in patches_list):
            all_elements = {el["id"]: el["page_id"] for el in self.get_elements(file_id)}
            for p in patches_list:
                if not p.get("page_id"):
                    p["page_id"] = all_elements.get(p["element_id"])

        if current_revn == 0:
            meta = self.get_file_meta(file_id)
            current_revn = meta.get("revn", 0)

        # Build change list
        changes: list[dict[str, Any]] = []
        for p in patches_list:
            eid = p.get("element_id")
            pid = p.get("page_id")
            pats = p.get("patches", {})
            if not eid or not pid or not pats:
                continue
            operations = [
                {"type": "set", "attr": _PATCH_KEY_MAP.get(k, k), "val": v}
                for k, v in pats.items()
            ]
            changes.append({
                "type": "mod-obj",
                "page-id": pid,
                "id": eid,
                "operations": operations,
            })

        if not changes:
            return {"ok": False, "error": "No valid patches to apply"}

        try:
            client = self._get_session()
            resp = client.post(
                f"{self._base}/api/rpc/command/update-file",
                json={
                    "id": file_id,
                    "revn": current_revn,
                    "components-v2": True,
                    "changes": changes,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return {"ok": True, "revn": data.get("revn", current_revn + 1), "applied": len(changes)}
        except Exception as e:
            return {"ok": False, "error": str(e), "partial": [p.get("element_id") for p in patches_list]}

    def add_text_element(
        self,
        file_id: str,
        page_id: str,
        text: str,
        x: int = 100,
        y: int = 100,
        width: int = 300,
        height: int = 50,
        font_size: int = 16,
        current_revn: int = 0,
    ) -> dict[str, Any]:
        """
        Add a new text element to a Penpot page.

        Returns: {"ok": True, "element_id": "<new-uuid>", "revn": ...}
        """
        import uuid as _uuid
        new_id = str(_uuid.uuid4())

        if current_revn == 0:
            meta = self.get_file_meta(file_id)
            current_revn = meta.get("revn", 0)

        change = {
            "type": "add-obj",
            "id": new_id,
            "page-id": page_id,
            "obj": {
                "id": new_id,
                "type": "text",
                "name": text[:40],
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "content": {
                    "type": "root",
                    "children": [{
                        "type": "paragraph-set",
                        "children": [{
                            "type": "paragraph",
                            "children": [{
                                "text": text,
                                "fontSize": str(font_size),
                                "fontFamily": "Work Sans",
                                "fills": [{"fill-color": "#1a1a1a", "fill-opacity": 1}],
                            }],
                        }],
                    }],
                },
            },
        }

        try:
            client = self._get_session()
            resp = client.post(
                f"{self._base}/api/rpc/command/update-file",
                json={
                    "id": file_id,
                    "revn": current_revn,
                    "components-v2": True,
                    "changes": [change],
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return {"ok": True, "element_id": new_id, "revn": data.get("revn", current_revn + 1)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_element(
        self,
        file_id: str,
        page_id: str,
        element_id: str,
        current_revn: int = 0,
    ) -> dict[str, Any]:
        """
        Delete an element from a Penpot page.
        Returns {"ok": True, "revn": ...} or {"ok": False, "error": ...}.
        """
        if current_revn == 0:
            meta = self.get_file_meta(file_id)
            current_revn = meta.get("revn", 0)

        change = {
            "type": "del-obj",
            "id": element_id,
            "page-id": page_id,
        }

        try:
            client = self._get_session()
            resp = client.post(
                f"{self._base}/api/rpc/command/update-file",
                json={
                    "id": file_id,
                    "revn": current_revn,
                    "components-v2": True,
                    "changes": [change],
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return {"ok": True, "revn": data.get("revn", current_revn + 1)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_wireframe_files(
        self,
        svg: str,
        json_data: dict[str, Any],
        output_dir: str,
        filename: str = "wireframe",
    ) -> dict[str, str]:
        """
        Persist SVG and JSON wireframe representations to *output_dir*.

        Both files are written atomically (write-then-rename) so partial
        writes are never left on disk.

        Returns a dict: ``{"svg": "/abs/path/wireframe.svg", "json": "/abs/path/wireframe.json"}``
        """
        import tempfile

        os.makedirs(output_dir, exist_ok=True)
        svg_path  = os.path.join(output_dir, f"{filename}.svg")
        json_path = os.path.join(output_dir, f"{filename}.json")

        # Write SVG atomically
        fd, tmp = tempfile.mkstemp(dir=output_dir, suffix=".svg.tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(svg)
            os.replace(tmp, svg_path)
        except Exception:
            os.unlink(tmp)
            raise

        # Write JSON atomically
        fd2, tmp2 = tempfile.mkstemp(dir=output_dir, suffix=".json.tmp")
        try:
            with os.fdopen(fd2, "w", encoding="utf-8") as fh:
                json.dump(json_data, fh, indent=2)
            os.replace(tmp2, json_path)
        except Exception:
            os.unlink(tmp2)
            raise

        return {"svg": os.path.abspath(svg_path), "json": os.path.abspath(json_path)}

    def poll_for_penpot_changes(
        self,
        file_id: str,
        interval_s: float = 5.0,
        timeout_s: float = 300.0,
        on_change: Any = None,
    ) -> dict[str, Any] | None:
        """
        Poll Penpot for remote edits to *file_id* (e.g. browser-side changes).

        Compares the ``revn`` (revision number) of the file on each tick.
        Stops when:
          - the revision number increases (change detected) → returns updated JSON
          - *timeout_s* elapses without a change                → returns ``None``

        Args:
            file_id:    Penpot file id to watch.
            interval_s: seconds between polls (default 5).
            timeout_s:  maximum total wait in seconds (default 300 = 5 min).
            on_change:  optional callable(new_json) invoked on each detected change.

        Returns the latest exported JSON dict, or ``None`` on timeout.
        """
        import time

        deadline = time.monotonic() + timeout_s
        baseline_revn: int | None = None

        while time.monotonic() < deadline:
            try:
                client = self._get_session()
                resp = client.get(
                    f"{self._base}/api/rpc/command/get-file",
                    params={"id": file_id},
                )
                resp.raise_for_status()
                file_meta = resp.json()
                current_revn: int = file_meta.get("revn", 0)

                if baseline_revn is None:
                    baseline_revn = current_revn
                elif current_revn > baseline_revn:
                    # Revision bumped — export and return fresh JSON
                    updated = self.export_json(file_id)
                    if on_change is not None:
                        on_change(updated)
                    return updated
            except Exception:
                pass  # transient network error; keep polling

            remaining = deadline - time.monotonic()
            time.sleep(min(interval_s, max(0, remaining)))

        return None  # timeout

    # ------------------------------------------------------------------
    # Spec → Penpot changes conversion (T-P2-01 / T-P2-04)
    # ------------------------------------------------------------------

    @staticmethod
    def _spec_to_changes(spec: dict[str, Any]) -> list[dict[str, Any]]:
        """
        Convert a design spec dict into a flat list of Penpot change operations.

        Each change is a Penpot "add-obj" or "add-page" operation.
        Pages are created first; then for each page a frame (artboard) and
        individual shape elements (header, sections, footer, buttons, etc.)
        are added as separate top-level layers — T-P2-04: every element is an
        independently selectable layer group in Penpot.

        Design spec format (all keys optional):
        {
          "title": "My App",
          "pages": [
            {
              "name": "Home",
              "sections": ["hero", "features", "footer"],
              "components": [
                {"type": "button", "label": "Sign Up", "x": 100, "y": 400, "w": 160, "h": 48},
                {"type": "input",  "label": "Email",   "x": 100, "y": 460, "w": 280, "h": 40},
              ]
            }
          ]
        }
        """
        pages_spec = spec.get("pages", [{"name": "Home", "sections": ["hero", "features", "footer"]}])
        changes: list[dict[str, Any]] = []

        # ---- Constants ----
        W, H = 1440, 900
        HEADER_H = 72
        FOOTER_H = 60
        BG_COLOR = "#f5f5f5"
        HEADER_COLOR = "#1a1a1a"
        FOOTER_COLOR = "#333333"
        SECTION_COLORS = ["#e8e8e8", "#f0f0f0"]
        TEXT_COLOR = "#333333"
        WHITE = "#ffffff"

        def _new_id() -> str:
            return str(_uuid_mod.uuid4())

        def _text_content(text_str: str, font_size: int = 14, color: str = TEXT_COLOR) -> dict:
            return {
                "type": "root",
                "children": [{
                    "type": "paragraph-set",
                    "children": [{
                        "type": "paragraph",
                        "children": [{
                            "text": text_str,
                            "fontSize": str(font_size),
                            "fontFamily": "Work Sans",
                            "fills": [{"fill-color": color, "fill-opacity": 1}],
                        }],
                    }],
                }],
            }

        def _rect_obj(
            obj_id: str, name: str, x: float, y: float, w: float, h: float,
            fill_color: str = BG_COLOR, opacity: float = 1.0,
            stroke_color: str | None = None,
        ) -> dict:
            obj: dict[str, Any] = {
                "id": obj_id, "type": "rect", "name": name,
                "x": x, "y": y, "width": w, "height": h,
                "opacity": opacity,
                "fills": [{"fill-color": fill_color, "fill-opacity": opacity}],
                "strokes": [],
            }
            if stroke_color:
                obj["strokes"] = [{"stroke-color": stroke_color, "stroke-width": 1, "stroke-position": "inner"}]
            return obj

        def _text_obj(
            obj_id: str, name: str, text_str: str, x: float, y: float,
            w: float, h: float, font_size: int = 14, color: str = TEXT_COLOR,
        ) -> dict:
            return {
                "id": obj_id, "type": "text", "name": name,
                "x": x, "y": y, "width": w, "height": h,
                "opacity": 1.0,
                "fills": [],
                "strokes": [],
                "content": _text_content(text_str, font_size=font_size, color=color),
            }

        for page_spec in pages_spec:
            if isinstance(page_spec, str):
                page_spec = {"name": page_spec, "sections": []}
            page_name: str = page_spec.get("name", "Page")
            sections_raw = page_spec.get("sections", ["hero", "features", "footer"])
            components: list[dict] = page_spec.get("components", [])

            # --- Create page ---
            page_id = _new_id()
            changes.append({
                "type": "add-page",
                "id": page_id,
                "name": page_name,
            })

            # --- Root artboard frame ---
            frame_id = _new_id()
            changes.append({
                "type": "add-obj",
                "id": frame_id,
                "page-id": page_id,
                "obj": {
                    "id": frame_id, "type": "frame", "name": f"{page_name} — Canvas",
                    "x": 0, "y": 0, "width": W, "height": H,
                    "fills": [{"fill-color": BG_COLOR, "fill-opacity": 1}],
                    "strokes": [],
                    "opacity": 1.0,
                    "shapes": [],  # child ids added below
                },
            })

            child_ids: list[str] = []

            # --- Header layer group (T-P2-04: paired elements in named group) ---
            hdr_grp_id = _new_id()
            hdr_id = _new_id()
            nav_id = _new_id()
            title_str: str = spec.get("title", "Untitled")

            # Inner elements of the "Header" group
            changes.append({"type": "add-obj", "id": hdr_id, "page-id": page_id, "parent-id": hdr_grp_id,
                            "obj": _rect_obj(hdr_id, "header-bg", 0, 0, W, HEADER_H, fill_color=HEADER_COLOR)})
            changes.append({"type": "add-obj", "id": nav_id, "page-id": page_id, "parent-id": hdr_grp_id,
                            "obj": _text_obj(nav_id, "nav-title", title_str, 32, 18, 400, 36, font_size=20, color=WHITE)})

            # Group frame for header
            changes.append({"type": "add-obj", "id": hdr_grp_id, "page-id": page_id, "parent-id": frame_id,
                            "obj": {
                                "id": hdr_grp_id, "type": "frame", "name": "Header",
                                "x": 0, "y": 0, "width": W, "height": HEADER_H,
                                "fills": [], "strokes": [], "opacity": 1.0,
                                "shapes": [hdr_id, nav_id],
                            }})
            child_ids.append(hdr_grp_id)

            # --- Section layers (each section is an independent group — T-P2-04) ---
            y_cursor = float(HEADER_H + 8)
            avail_h = H - HEADER_H - FOOTER_H - 16
            sec_h = min(240.0, avail_h / max(len(sections_raw), 1))

            for i, sec in enumerate(sections_raw):
                sec_name = sec if isinstance(sec, str) else sec.get("name", f"section-{i+1}")
                color = SECTION_COLORS[i % 2]

                sec_grp_id = _new_id()
                sec_id = _new_id()
                lbl_id = _new_id()

                changes.append({"type": "add-obj", "id": sec_id, "page-id": page_id, "parent-id": sec_grp_id,
                                "obj": _rect_obj(sec_id, f"{sec_name}-bg", 0, 0, W, sec_h,
                                                 fill_color=color, stroke_color="#cccccc")})
                changes.append({"type": "add-obj", "id": lbl_id, "page-id": page_id, "parent-id": sec_grp_id,
                                "obj": _text_obj(lbl_id, f"{sec_name}-label",
                                                  sec_name.replace("-", " ").title(),
                                                  32, 16, 600, 32, font_size=18, color=TEXT_COLOR)})

                # Section group frame (T-P2-04: independent layer group per section)
                changes.append({"type": "add-obj", "id": sec_grp_id, "page-id": page_id, "parent-id": frame_id,
                                "obj": {
                                    "id": sec_grp_id, "type": "frame",
                                    "name": sec_name.replace("-", " ").title(),
                                    "x": 0, "y": y_cursor, "width": W, "height": sec_h,
                                    "fills": [], "strokes": [], "opacity": 1.0,
                                    "shapes": [sec_id, lbl_id],
                                }})
                child_ids.append(sec_grp_id)
                y_cursor += sec_h

            # --- Custom components — each wrapped in an independent layer group (T-P2-04) ---
            for comp in components:
                comp_type = comp.get("type", "rect")
                label = comp.get("label", comp_type)
                cx = float(comp.get("x", 100))
                cy = float(comp.get("y", 200))
                cw = float(comp.get("w", 160))
                ch = float(comp.get("h", 48))

                # Group frame for each component
                grp_id = _new_id()
                group_children: list[str] = []

                if comp_type == "button":
                    bg_id = _new_id()
                    txt_id = _new_id()
                    changes.append({"type": "add-obj", "id": bg_id, "page-id": page_id, "parent-id": grp_id,
                                    "obj": _rect_obj(bg_id, "background", 0, 0, cw, ch,
                                                     fill_color="#1d6ef5")})
                    changes.append({"type": "add-obj", "id": txt_id, "page-id": page_id, "parent-id": grp_id,
                                    "obj": _text_obj(txt_id, "label", label, 12, 12, cw - 24, ch - 24,
                                                      font_size=14, color=WHITE)})
                    group_children = [bg_id, txt_id]

                elif comp_type == "input":
                    bg_id = _new_id()
                    ph_id = _new_id()
                    changes.append({"type": "add-obj", "id": bg_id, "page-id": page_id, "parent-id": grp_id,
                                    "obj": _rect_obj(bg_id, "background", 0, 0, cw, ch,
                                                     fill_color=WHITE, stroke_color="#cccccc")})
                    changes.append({"type": "add-obj", "id": ph_id, "page-id": page_id, "parent-id": grp_id,
                                    "obj": _text_obj(ph_id, "placeholder", label, 10, 10, cw - 20, ch - 20,
                                                      font_size=13, color="#aaaaaa")})
                    group_children = [bg_id, ph_id]

                elif comp_type == "text":
                    txt_id = _new_id()
                    changes.append({"type": "add-obj", "id": txt_id, "page-id": page_id, "parent-id": grp_id,
                                    "obj": _text_obj(txt_id, "text", label, 0, 0, cw, ch,
                                                      font_size=int(comp.get("font_size", 14)))})
                    group_children = [txt_id]

                else:
                    # Generic rect
                    rect_id = _new_id()
                    changes.append({"type": "add-obj", "id": rect_id, "page-id": page_id, "parent-id": grp_id,
                                    "obj": _rect_obj(rect_id, "shape", 0, 0, cw, ch,
                                                     fill_color=comp.get("fill", "#dddddd"))})
                    group_children = [rect_id]

                # T-P2-04: wrap component elements in named layer group
                changes.append({"type": "add-obj", "id": grp_id, "page-id": page_id, "parent-id": frame_id,
                                "obj": {
                                    "id": grp_id, "type": "frame",
                                    "name": f"{comp_type.capitalize()} — {label}",
                                    "x": cx, "y": cy, "width": cw, "height": ch,
                                    "fills": [], "strokes": [], "opacity": 1.0,
                                    "shapes": group_children,
                                }})
                child_ids.append(grp_id)

            # --- Footer layer group (T-P2-04: independent layer group) ---
            ftr_grp_id = _new_id()
            ftr_id = _new_id()
            ftr_txt_id = _new_id()

            changes.append({"type": "add-obj", "id": ftr_id, "page-id": page_id, "parent-id": ftr_grp_id,
                            "obj": _rect_obj(ftr_id, "footer-bg", 0, 0, W, FOOTER_H,
                                             fill_color=FOOTER_COLOR)})
            changes.append({"type": "add-obj", "id": ftr_txt_id, "page-id": page_id, "parent-id": ftr_grp_id,
                            "obj": _text_obj(ftr_txt_id, "footer-text", f"© {title_str}",
                                              32, 18, 400, 24, font_size=12, color="#aaaaaa")})
            changes.append({"type": "add-obj", "id": ftr_grp_id, "page-id": page_id, "parent-id": frame_id,
                            "obj": {
                                "id": ftr_grp_id, "type": "frame", "name": "Footer",
                                "x": 0, "y": H - FOOTER_H, "width": W, "height": FOOTER_H,
                                "fills": [], "strokes": [], "opacity": 1.0,
                                "shapes": [ftr_id, ftr_txt_id],
                            }})
            child_ids.append(ftr_grp_id)

            # --- Back-fill the frame's children list ---
            changes.append({
                "type": "mod-obj",
                "id": frame_id,
                "page-id": page_id,
                "operations": [{"type": "set", "attr": "shapes", "val": child_ids}],
            })

        return changes

    @staticmethod
    def _generate_svg_wireframe(spec: dict[str, Any]) -> str:
        """
        Generate a minimal SVG wireframe locally (no Docker required).
        Elements include named sections: header, nav, section-N, footer.
        """
        title = str(spec.get("title", "Wireframe"))
        pages = spec.get("pages", [{"name": "Home", "sections": ["hero", "features", "footer"]}])

        # Use first page
        page = pages[0] if pages else {}
        page_name = page.get("name", "Home") if isinstance(page, dict) else "Home"
        sections = page.get("sections", ["hero", "features", "footer"]) if isinstance(page, dict) else []

        W, H = 1440, 900
        lines = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
            f'viewBox="0 0 {W} {H}" style="background:#f5f5f5;">',
            f'  <title>{title} — {page_name}</title>',
            # Header
            f'  <rect id="header" x="0" y="0" width="{W}" height="72" fill="#1a1a1a"/>',
            f'  <text id="nav" x="32" y="44" font-size="20" fill="white" font-family="sans-serif">{title}</text>',
        ]

        y = 80
        sec_h = min(240, (H - 80 - 60) // max(len(sections), 1))
        for i, sec in enumerate(sections):
            color = "#e8e8e8" if i % 2 == 0 else "#f0f0f0"
            lines += [
                f'  <rect id="section-{i+1}" x="0" y="{y}" width="{W}" height="{sec_h}" fill="{color}" stroke="#ccc"/>',
                f'  <text x="32" y="{y+32}" font-size="16" fill="#333" font-family="sans-serif">{sec}</text>',
            ]
            y += sec_h

        # Footer
        lines += [
            f'  <rect id="footer" x="0" y="{H-60}" width="{W}" height="60" fill="#333"/>',
            f'  <text x="32" y="{H-28}" font-size="12" fill="#aaa" font-family="sans-serif">© {title}</text>',
            "</svg>",
        ]
        return "\n".join(lines)
