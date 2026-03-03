"""
Canonical path helpers for the Pakalon agent pipeline.

All phase output, wireframe, and test-evidence artifacts MUST live under:
  {project_dir}/.pakalon-agents/ai-agents/phase-{N}/

Usage:
    from ..shared.paths import get_phase_dir, get_agents_root, get_wireframes_dir

    phase1_dir  = get_phase_dir(project_dir, 1)   # …/.pakalon-agents/ai-agents/phase-1/
    agents_root = get_agents_root(project_dir)     # …/.pakalon-agents/ai-agents/
    wf_dir      = get_wireframes_dir(project_dir)  # …/.pakalon-agents/wireframes/
"""

import pathlib


def get_agents_root(project_dir: str | pathlib.Path) -> pathlib.Path:
    """Return the canonical AI agents root directory (.pakalon-agents/ai-agents/)."""
    return pathlib.Path(project_dir) / ".pakalon-agents" / "ai-agents"


def get_phase_dir(project_dir: str | pathlib.Path, phase_num: int, create: bool = True) -> pathlib.Path:
    """
    Return (and optionally create) the canonical output directory for a given phase.

    Args:
        project_dir: The user's project root.
        phase_num: Phase number (1-6).
        create: If True, mkdir with parents if it doesn't exist.

    Returns:
        pathlib.Path: e.g. <project_dir>/.pakalon-agents/ai-agents/phase-1/
    """
    d = get_agents_root(project_dir) / f"phase-{phase_num}"
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def get_wireframes_dir(project_dir: str | pathlib.Path, create: bool = True) -> pathlib.Path:
    """Return the canonical wireframes directory under .pakalon-agents/."""
    d = pathlib.Path(project_dir) / ".pakalon-agents" / "wireframes"
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def get_mcp_servers_dir(project_dir: str | pathlib.Path, create: bool = True) -> pathlib.Path:
    """Return the canonical mcp-servers directory under .pakalon-agents/."""
    d = pathlib.Path(project_dir) / ".pakalon-agents" / "mcp-servers"
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def get_tdd_screenshots_dir(project_dir: str | pathlib.Path, phase_num: int = 2, create: bool = True) -> pathlib.Path:
    """Return the canonical TDD screenshots directory for a given phase."""
    d = get_phase_dir(project_dir, phase_num, create=False) / "tdd-screenshots"
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def get_test_evidence_dir(project_dir: str | pathlib.Path, create: bool = True) -> pathlib.Path:
    """Return the canonical test-evidence directory under phase-3."""
    d = get_phase_dir(project_dir, 3, create=False) / "test-evidence"
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d
