"""
Cross-phase decision registry for Pakalon agent pipeline.

Records key decisions made during each phase and stores them in
.pakalon-agents/decisions.json so the complete lineage can be traced.

Usage:
    from ..shared.decision_registry import record_decision, get_decisions, link_decisions

    record_decision(project_dir, {
        "phase": 1,
        "type": "requirement",
        "description": "App will use REST API over GraphQL",
        "source_file": "phase-1/requirements.md",
    })

    decisions = get_decisions(project_dir, phase=2)
    link_decisions(project_dir, from_id="d-001", to_id="d-007")
"""

from __future__ import annotations

import json
import pathlib
import time
import uuid
from typing import Any, Optional

from .paths import get_agents_root


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _registry_path(project_dir: str | pathlib.Path) -> pathlib.Path:
    root = get_agents_root(project_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root / "decisions.json"


def _load(project_dir: str | pathlib.Path) -> dict[str, Any]:
    p = _registry_path(project_dir)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"decisions": [], "links": []}


def _save(project_dir: str | pathlib.Path, data: dict[str, Any]) -> None:
    p = _registry_path(project_dir)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def record_decision(
    project_dir: str | pathlib.Path,
    *,
    phase: int,
    decision_type: str,
    description: str,
    source_file: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> str:
    """
    Record a decision made during a pipeline phase.

    Args:
        project_dir:    Project root directory.
        phase:          Phase number (1-6).
        decision_type:  Semantic category — e.g. "requirement", "architecture",
                        "technology_choice", "security_finding", "implementation",
                        "test_result", "deployment".
        description:    Human-readable description of the decision.
        source_file:    Optional relative path to artefact that contains the context.
        metadata:       Optional extra structured fields.

    Returns:
        The generated decision_id (e.g. "d-<uuid4>").
    """
    decision_id = f"d-{uuid.uuid4().hex[:8]}"
    entry: dict[str, Any] = {
        "decision_id": decision_id,
        "phase": phase,
        "type": decision_type,
        "description": description,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if source_file:
        entry["source_file"] = source_file
    if metadata:
        entry["metadata"] = metadata

    data = _load(project_dir)
    data["decisions"].append(entry)
    _save(project_dir, data)
    return decision_id


def get_decisions(
    project_dir: str | pathlib.Path,
    phase: Optional[int] = None,
    decision_type: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Retrieve decisions, optionally filtered by phase and/or type.

    Returns a list of decision dicts in chronological order.
    """
    data = _load(project_dir)
    decisions = data.get("decisions", [])

    if phase is not None:
        decisions = [d for d in decisions if d.get("phase") == phase]
    if decision_type is not None:
        decisions = [d for d in decisions if d.get("type") == decision_type]

    return decisions


def link_decisions(
    project_dir: str | pathlib.Path,
    from_id: str,
    to_id: str,
    relationship: str = "informs",
) -> None:
    """
    Link two decisions to express a traceability relationship.

    Args:
        project_dir:  Project root directory.
        from_id:      Source decision_id.
        to_id:        Target decision_id.
        relationship: Semantic label — "informs", "supersedes", "caused_by", etc.
    """
    data = _load(project_dir)
    data.setdefault("links", []).append({
        "from": from_id,
        "to": to_id,
        "relationship": relationship,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    _save(project_dir, data)


def get_decision_by_id(
    project_dir: str | pathlib.Path,
    decision_id: str,
) -> Optional[dict[str, Any]]:
    """Return a single decision by its ID, or None if not found."""
    for d in _load(project_dir).get("decisions", []):
        if d.get("decision_id") == decision_id:
            return d
    return None


def get_links_for(
    project_dir: str | pathlib.Path,
    decision_id: str,
) -> list[dict[str, Any]]:
    """Return all links where decision_id appears as from or to."""
    links = _load(project_dir).get("links", [])
    return [lnk for lnk in links if lnk.get("from") == decision_id or lnk.get("to") == decision_id]


def get_summary(project_dir: str | pathlib.Path) -> dict[str, Any]:
    """
    Return a high-level summary of decisions grouped by phase.

    Useful for injecting into LLM prompts to give the agent full project context.
    """
    data = _load(project_dir)
    by_phase: dict[int, list[dict[str, Any]]] = {}
    for d in data.get("decisions", []):
        ph = d.get("phase", 0)
        by_phase.setdefault(ph, []).append(d)

    return {
        "total_decisions": len(data.get("decisions", [])),
        "total_links": len(data.get("links", [])),
        "by_phase": {str(k): v for k, v in sorted(by_phase.items())},
    }


def format_for_prompt(
    project_dir: str | pathlib.Path,
    max_per_phase: int = 5,
) -> str:
    """
    Format decisions as a compact Markdown string suitable for inclusion in LLM prompts.

    Limits to max_per_phase most recent decisions per phase to avoid context bloat.
    """
    data = _load(project_dir)
    decisions = data.get("decisions", [])
    if not decisions:
        return "(no prior decisions recorded)"

    by_phase: dict[int, list[dict[str, Any]]] = {}
    for d in decisions:
        ph = d.get("phase", 0)
        by_phase.setdefault(ph, []).append(d)

    lines: list[str] = ["## Prior Decisions\n"]
    for phase_num in sorted(by_phase.keys()):
        phase_decisions = by_phase[phase_num][-max_per_phase:]
        lines.append(f"### Phase {phase_num}")
        for d in phase_decisions:
            dtype = d.get("type", "decision")
            desc = d.get("description", "")
            lines.append(f"- [{dtype}] {desc}")
        lines.append("")

    return "\n".join(lines)
