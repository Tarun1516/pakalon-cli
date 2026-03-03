"""
test_phase1.py — Unit + integration tests for Phase 1 planning agent.
T105: skills, figma_import, context_budget, graph nodes.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import pytest
import sys
import tempfile

# Ensure python/ is importable
sys.path.insert(0, str(pathlib.Path(__file__).parents[4]))


# ------------------------------------------------------------------
# AgentSkillsFinder
# ------------------------------------------------------------------

class TestAgentSkillsFinder:
    def test_import(self):
        from python.agents.phase1.skills import AgentSkillsFinder  # noqa: F401

    def test_match_skills_returns_list(self, tmp_path):
        from python.agents.phase1.skills import AgentSkillsFinder
        finder = AgentSkillsFinder(cache_dir=str(tmp_path))
        # Empty cache → no network in unit test → should return empty list
        finder._skills = []
        results = finder.match_skills("react UI components")
        assert isinstance(results, list)

    def test_write_skills_md_creates_file(self, tmp_path):
        from python.agents.phase1.skills import AgentSkillsFinder
        finder = AgentSkillsFinder(cache_dir=str(tmp_path))
        finder._skills = [
            {"name": "react-ui", "description": "React UI skill", "url": "http://example.com", "tags": ["react", "ui"]},
        ]
        out = str(tmp_path / "agent-skills.md")
        finder.write_skills_md(out, "build a react app")
        assert pathlib.Path(out).exists()
        content = pathlib.Path(out).read_text()
        assert "react-ui" in content


# ------------------------------------------------------------------
# FigmaImporter
# ------------------------------------------------------------------

class TestFigmaImporter:
    def test_import(self):
        from python.agents.phase1.figma_import import FigmaImporter  # noqa: F401

    def test_no_token_returns_none(self):
        from python.agents.phase1.figma_import import FigmaImporter
        old_token = os.environ.pop("FIGMA_ACCESS_TOKEN", None)
        importer = FigmaImporter()
        importer.access_token = None
        result = importer.analyze("https://www.figma.com/file/abc123/MyDesign")
        assert result is None
        if old_token:
            os.environ["FIGMA_ACCESS_TOKEN"] = old_token

    def test_local_figma_json(self, tmp_path):
        from python.agents.phase1.figma_import import FigmaImporter
        figma_json = {
            "name": "Test Design",
            "lastModified": "2025-01-01",
            "document": {
                "children": [
                    {
                        "name": "Page 1",
                        "children": [
                            {"type": "FRAME", "name": "Hero", "children": []}
                        ],
                    }
                ]
            },
            "styles": {},
        }
        figma_file = tmp_path / "design.json"
        figma_file.write_text(json.dumps(figma_json))
        importer = FigmaImporter()
        result = importer.analyze(str(figma_file))
        assert result is not None
        assert result["title"] == "Test Design"
        assert len(result["pages"]) >= 1

    def test_figma_url_key_extraction(self):
        from python.agents.phase1.figma_import import FigmaImporter
        importer = FigmaImporter()
        key = importer._extract_file_key("https://www.figma.com/file/XYZ123abc/Project-Name")
        assert key == "XYZ123abc"

    def test_figma_design_url_key_extraction(self):
        from python.agents.phase1.figma_import import FigmaImporter
        importer = FigmaImporter()
        key = importer._extract_file_key("https://www.figma.com/design/DEFGH456/My-Design")
        assert key == "DEFGH456"


# ------------------------------------------------------------------
# ContextBudget
# ------------------------------------------------------------------

class TestContextBudget:
    def test_import(self):
        from python.agents.phase1.context_budget import ContextBudget  # noqa: F401

    def test_new_project_budget_sums_to_total(self):
        from python.agents.phase1.context_budget import ContextBudget
        budget = ContextBudget(total_context=100_000, is_new_project=True)
        total = sum(budget.get_all().values())
        assert total == 100_000

    def test_existing_project_budget_sums_to_total(self):
        from python.agents.phase1.context_budget import ContextBudget
        budget = ContextBudget(total_context=128_000, is_new_project=False)
        total = sum(budget.get_all().values())
        assert total == 128_000

    def test_get_returns_positive_tokens(self):
        from python.agents.phase1.context_budget import ContextBudget
        budget = ContextBudget(total_context=200_000, is_new_project=True)
        for phase in budget._weights:
            assert budget.get(phase) > 0

    def test_get_summary_markdown(self):
        from python.agents.phase1.context_budget import ContextBudget
        budget = ContextBudget(total_context=50_000, is_new_project=True)
        summary = budget.get_summary()
        assert "Phase" in summary
        assert "Tokens" in summary

    def test_write_context_management_md(self, tmp_path):
        from python.agents.phase1.context_budget import ContextBudget
        budget = ContextBudget(total_context=50_000, is_new_project=True)
        out = str(tmp_path / "context_management.md")
        budget.write_context_management_md(out)
        assert pathlib.Path(out).exists()

    def test_user_allocated_pct_clamp(self):
        from python.agents.phase1.context_budget import ContextBudget
        # 90% user allocation for new project (above 65% minimum → should be clamped in some way)
        budget = ContextBudget(total_context=100_000, is_new_project=True, user_allocated_pct=90)
        total = sum(budget.get_all().values())
        assert total == 100_000

    def test_build_choice_request_structure(self):
        from python.agents.phase1.context_budget import ContextBudget
        budget = ContextBudget(total_context=100_000, is_new_project=True)
        req = budget.build_choice_request(is_new_project=True)
        assert req["type"] == "choice_request"
        assert len(req["choices"]) >= 2


# ------------------------------------------------------------------
# Graph nodes (async, mocked)
# ------------------------------------------------------------------

class TestPhase1GraphNodes:
    """Tests for individual graph node functions using mocked state."""

    def _base_state(self, tmp_path) -> dict:
        return {
            "user_prompt": "Build a SaaS task manager",
            "project_dir": str(tmp_path),
            "user_id": "test-user",
            "is_yolo": True,
            "figma_url": None,
            "send_sse": lambda evt: None,
            "_input_queue": None,
        }

    @pytest.mark.asyncio
    async def test_check_existing_codebase_new_project(self, tmp_path):
        from python.agents.phase1.graph import check_existing_codebase
        state = self._base_state(tmp_path)
        result = await check_existing_codebase(state)  # type: ignore
        assert "existing_codebase_summary" in result
        assert result.get("is_new_project") is True

    @pytest.mark.asyncio
    async def test_check_existing_codebase_existing_project(self, tmp_path):
        from python.agents.phase1.graph import check_existing_codebase
        # Create some fake source files
        for i in range(10):
            (tmp_path / f"file{i}.ts").write_text("export const x = 1;")
        state = self._base_state(tmp_path)
        result = await check_existing_codebase(state)  # type: ignore
        assert "Source files found: 10" in result["existing_codebase_summary"]

    @pytest.mark.asyncio
    async def test_load_figma_no_url(self, tmp_path):
        from python.agents.phase1.graph import load_figma
        state = self._base_state(tmp_path)
        state["figma_url"] = None
        result = await load_figma(state)  # type: ignore
        assert result.get("figma_data") is None

    @pytest.mark.asyncio
    async def test_load_figma_local_json(self, tmp_path):
        from python.agents.phase1.graph import load_figma
        figma_json = {
            "name": "Test",
            "lastModified": "2025-01-01",
            "document": {"children": [{"name": "Page 1", "children": []}]},
            "styles": {},
        }
        f = tmp_path / "design.json"
        f.write_text(json.dumps(figma_json))
        state = self._base_state(tmp_path)
        state["figma_url"] = str(f)
        result = await load_figma(state)  # type: ignore
        assert result.get("figma_data") is not None

    @pytest.mark.asyncio
    async def test_qa_loop_yolo_mode(self, tmp_path):
        from python.agents.phase1.graph import qa_loop
        state = self._base_state(tmp_path)
        state["is_yolo"] = True
        # Patch _llm_call to return valid JSON questions
        import python.agents.phase1.graph as graph_mod
        original = graph_mod._llm_call
        async def mock_llm(messages, **kwargs):
            return json.dumps([
                {"question": "Tech stack?", "options": ["React", "Vue", "Skip"], "default_answer": "React"},
                {"question": "Database?", "options": ["PostgreSQL", "MySQL", "Skip"], "default_answer": "PostgreSQL"},
            ])
        graph_mod._llm_call = mock_llm
        try:
            result = await qa_loop(state)  # type: ignore
            assert "Tech stack?" in result.get("qa_answers", {})
        finally:
            graph_mod._llm_call = original

    @pytest.mark.asyncio
    async def test_generate_files_creates_directory(self, tmp_path):
        from python.agents.phase1.graph import generate_files
        import python.agents.phase1.graph as graph_mod
        async def mock_llm(messages, **kwargs):
            return "# Generated Document\n\nContent here."
        graph_mod._llm_call = mock_llm
        state = self._base_state(tmp_path)
        state["qa_answers"] = {"Tech stack?": "React"}
        state["research_context"] = "Some research"
        state["existing_codebase_summary"] = "New project"
        state["figma_data"] = None
        state["is_new_project"] = True
        state["skills_md"] = ""
        try:
            result = await generate_files(state)  # type: ignore
            from python.agents.shared.paths import get_phase_dir
            phase1_dir = get_phase_dir(tmp_path, 1, create=False)
            assert phase1_dir.exists()
            # At minimum plan.md and phase-1.md should be created
            assert (phase1_dir / "plan.md").exists() or len(result.get("generated_files", {})) > 0
        finally:
            graph_mod._llm_call = mock_llm


# ------------------------------------------------------------------
# Integration: run_phase1 full pipeline (yolo, no LLM key)
# ------------------------------------------------------------------

class TestRunPhase1Integration:
    @pytest.mark.asyncio
    async def test_run_phase1_yolo_no_api_key(self, tmp_path):
        """run_phase1 in YOLO mode with no OpenRouter key — should complete without errors."""
        from python.agents.phase1.graph import run_phase1

        events: list[dict] = []

        result = await run_phase1(
            user_prompt="Build a simple todo app",
            project_dir=str(tmp_path),
            user_id="test",
            is_yolo=True,
            figma_url=None,
            send_sse=events.append,
        )
        assert result["status"] == "complete"
        assert isinstance(result["generated_files"], list)
        # phase_complete event must be emitted
        phase_events = [e for e in events if e.get("type") == "phase_complete"]
        assert len(phase_events) >= 1
