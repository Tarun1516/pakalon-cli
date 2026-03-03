"""
test_phase2.py — Tests for Phase 2 wireframe/design agent.
T108: WireframeTDD, graph nodes.
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parents[4]))


class TestWireframeTDD:
    def test_import(self):
        from python.agents.phase2.tdd import WireframeTDD  # noqa: F401

    def test_compare_no_reference(self, tmp_path):
        from python.agents.phase2.tdd import WireframeTDD
        tdd = WireframeTDD()
        svg_path = tmp_path / "test.svg"
        svg_path.write_text("<svg/>")
        result = tdd.compare(str(svg_path), reference_path=None)
        assert result["passed"] is True
        assert result["similarity"] == 1.0

    def test_basic_svg_generated(self):
        from python.agents.phase2.tdd import WireframeTDD
        svg = WireframeTDD._basic_svg({"title": "Test Page"})
        assert "<svg" in svg
        assert "Test Page" in svg

    def test_generate_iteration_prompt_passed(self):
        from python.agents.phase2.tdd import WireframeTDD
        tdd = WireframeTDD()
        prompt = tdd.generate_iteration_prompt({"passed": True, "similarity": 1.0, "missing_elements": []})
        assert "No changes" in prompt

    def test_generate_iteration_prompt_failed(self):
        from python.agents.phase2.tdd import WireframeTDD
        tdd = WireframeTDD()
        prompt = tdd.generate_iteration_prompt({
            "passed": False,
            "similarity": 0.7,
            "missing_elements": ["navbar", "footer"],
            "suggestions": [],
        })
        assert "navbar" in prompt
        assert "footer" in prompt

    @pytest.mark.asyncio
    async def test_run_tdd_loop_no_reference(self, tmp_path):
        from python.agents.phase2.tdd import WireframeTDD
        tdd = WireframeTDD()
        spec = {"title": "Test", "pages": []}
        events: list = []
        result = await tdd.run_tdd_loop(spec, reference_path=None, max_iterations=2, send_sse=events.append)
        assert "svg" in result
        assert result["iterations_run"] >= 1


class TestPhase2GraphNodes:
    def _base_state(self, tmp_path) -> dict:
        return {
            "project_dir": str(tmp_path),
            "user_id": "test",
            "is_yolo": True,
            "send_sse": lambda e: None,
        }

    @pytest.mark.asyncio
    async def test_read_phase1_missing_dir(self, tmp_path):
        from python.agents.phase2.graph import read_phase1
        state = self._base_state(tmp_path)
        result = await read_phase1(state)  # type: ignore
        assert isinstance(result.get("phase1_summary"), dict)

    @pytest.mark.asyncio
    async def test_read_phase1_with_files(self, tmp_path):
        from python.agents.phase2.graph import read_phase1
        from python.agents.shared.paths import get_phase_dir
        phase1_dir = get_phase_dir(tmp_path, 1)
        phase1_dir.mkdir(parents=True, exist_ok=True)
        (phase1_dir / "plan.md").write_text("# Plan\n\nTest plan content.")
        state = self._base_state(tmp_path)
        result = await read_phase1(state)  # type: ignore
        assert "plan.md" in result["phase1_summary"]

    @pytest.mark.asyncio
    async def test_check_figma_no_file(self, tmp_path):
        from python.agents.phase2.graph import check_figma
        state = self._base_state(tmp_path)
        result = await check_figma(state)  # type: ignore
        assert result.get("figma_data") is None

    @pytest.mark.asyncio
    async def test_check_figma_with_file(self, tmp_path):
        from python.agents.phase2.graph import check_figma
        from python.agents.shared.paths import get_phase_dir
        phase1_dir = get_phase_dir(tmp_path, 1)
        phase1_dir.mkdir(parents=True, exist_ok=True)
        (phase1_dir / "figma.json").write_text(json.dumps({"name": "Test", "colors": []}))
        state = self._base_state(tmp_path)
        result = await check_figma(state)  # type: ignore
        assert result.get("figma_data") is not None

    @pytest.mark.asyncio
    async def test_generate_penpot_creates_spec(self, tmp_path):
        from python.agents.phase2.graph import generate_penpot
        state = self._base_state(tmp_path)
        state["phase1_summary"] = {"design.md": "## Home\n## Dashboard\n"}
        state["figma_data"] = None
        result = await generate_penpot(state)  # type: ignore
        assert isinstance(result.get("wireframe_spec"), dict)
        assert isinstance(result.get("wireframe_svg"), str)
        assert "<svg" in result["wireframe_svg"]

    @pytest.mark.asyncio
    async def test_save_outputs_creates_files(self, tmp_path):
        from python.agents.phase2.graph import save_outputs
        state = self._base_state(tmp_path)
        state["wireframe_svg"] = "<svg/>"
        state["tdd_result"] = {"iterations_run": 1, "compare_result": {"similarity": 1.0}}
        result = await save_outputs(state)  # type: ignore
        from python.agents.shared.paths import get_phase_dir
        out_dir = get_phase_dir(tmp_path, 2, create=False)
        assert out_dir.exists()
        assert (out_dir / "wireframe-final.svg").exists()
        assert (out_dir / "phase-2.md").exists()


class TestRunPhase2Integration:
    @pytest.mark.asyncio
    async def test_run_phase2_yolo(self, tmp_path):
        from python.agents.phase2.graph import run_phase2
        events: list = []
        result = await run_phase2(
            project_dir=str(tmp_path),
            user_id="test",
            is_yolo=True,
            send_sse=events.append,
        )
        assert result["status"] == "complete"
        phase_events = [e for e in events if e.get("type") == "phase_complete"]
        assert len(phase_events) >= 1
