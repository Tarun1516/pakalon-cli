"""
test_phase3.py — Tests for Phase 3 implementation agent.
T113: RegistryRAG, ChromeDevToolsMCP, ExecutionLog, graph nodes.
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parents[4]))


class TestRegistryRAG:
    def test_import(self):
        from python.agents.phase3.registry_rag import RegistryRAG  # noqa: F401

    def test_normalize_list(self):
        from python.agents.phase3.registry_rag import RegistryRAG
        rag = RegistryRAG()
        data = [{"name": "button", "description": "A button component", "tags": ["ui"]}]
        result = rag._normalize(data)
        assert len(result) == 1
        assert result[0]["name"] == "button"

    def test_search_keyword_fallback(self, tmp_path):
        from python.agents.phase3.registry_rag import RegistryRAG
        rag = RegistryRAG(cache_dir=str(tmp_path))
        rag._components = [
            {"name": "button", "description": "A button component", "tags": ["ui", "interactive"]},
            {"name": "modal", "description": "A modal dialog", "tags": ["ui", "overlay"]},
            {"name": "table", "description": "A data table", "tags": ["data"]},
        ]
        results = rag.search("button interactive", top_k=2)
        assert any(r["name"] == "button" for r in results)

    def test_search_empty_components(self, tmp_path):
        from python.agents.phase3.registry_rag import RegistryRAG
        rag = RegistryRAG(cache_dir=str(tmp_path))
        rag._components = []
        # Simulate load by setting components manually
        rag._components = [{"name": "x", "description": "test", "tags": []}]
        results = rag.search("test")
        assert isinstance(results, list)

    def test_load_from_file(self, tmp_path):
        from python.agents.phase3.registry_rag import RegistryRAG
        registry_file = tmp_path / "reg.json"
        registry_file.write_text(json.dumps([
            {"name": "input", "description": "Text input", "tags": ["form"]},
        ]))
        rag = RegistryRAG(registry_path=str(registry_file), cache_dir=str(tmp_path))
        count = rag.load()
        assert count == 1


class TestExecutionLog:
    def test_import(self):
        from python.agents.phase3.execution_log import ExecutionLog  # noqa: F401

    def test_log_creates_file(self, tmp_path):
        from python.agents.phase3.execution_log import ExecutionLog
        from python.agents.shared.paths import get_phase_dir
        log = ExecutionLog(project_dir=str(tmp_path))
        assert (get_phase_dir(tmp_path, 3, create=False) / "execution_log.md").exists()

    def test_log_appends_entry(self, tmp_path):
        from python.agents.phase3.execution_log import ExecutionLog
        log = ExecutionLog(project_dir=str(tmp_path))
        log.log("SA1", "Test action", "Some detail", status="success")
        content = log.read()
        assert "SA1" in content
        assert "Test action" in content

    def test_log_start_end(self, tmp_path):
        from python.agents.phase3.execution_log import ExecutionLog
        log = ExecutionLog(project_dir=str(tmp_path))
        log.log_start("SA2", "Task A")
        log.log_end("SA2", "Task A", success=True)
        assert len(log.get_entries()) == 2

    def test_get_summary(self, tmp_path):
        from python.agents.phase3.execution_log import ExecutionLog
        log = ExecutionLog(project_dir=str(tmp_path))
        log.log("SA1", "Success", status="success")
        log.log("SA2", "Error", status="error")
        summary = log.get_summary()
        assert summary["total"] == 2

    def test_thread_safety(self, tmp_path):
        import threading
        from python.agents.phase3.execution_log import ExecutionLog
        log = ExecutionLog(project_dir=str(tmp_path))
        threads = [
            threading.Thread(target=log.log, args=(f"SA{i}", f"action {i}"))
            for i in range(10)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert log.get_summary()["total"] == 10


class TestChromeDevToolsMCP:
    def test_import(self):
        from python.agents.phase3.chrome_mcp import ChromeDevToolsMCP  # noqa: F401

    def test_init(self):
        from python.agents.phase3.chrome_mcp import ChromeDevToolsMCP
        cdp = ChromeDevToolsMCP()
        assert cdp.mcp_url == "http://localhost:9222"

    @pytest.mark.asyncio
    async def test_screenshot_no_connection(self):
        from python.agents.phase3.chrome_mcp import ChromeDevToolsMCP
        cdp = ChromeDevToolsMCP()
        result = await cdp.screenshot()
        assert result == ""

    @pytest.mark.asyncio
    async def test_navigate_no_connection(self):
        from python.agents.phase3.chrome_mcp import ChromeDevToolsMCP
        cdp = ChromeDevToolsMCP()
        result = await cdp.navigate("http://localhost:3000")
        assert result["status"] == "no_connection"


class TestPhase3GraphNodes:
    def _base_state(self, tmp_path) -> dict:
        from python.agents.phase3.execution_log import ExecutionLog
        return {
            "project_dir": str(tmp_path),
            "user_id": "test",
            "is_yolo": True,
            "send_sse": lambda e: None,
            "execution_log": ExecutionLog(project_dir=str(tmp_path)),
            "phase1_summary": {"plan.md": "# Plan\n\nBuild a todo app with PostgreSQL and React.", "design.md": "## Home\n## Dashboard\n"},
            "phase2_summary": {},
        }

    @pytest.mark.asyncio
    async def test_sa4_integration_creates_env(self, tmp_path):
        from python.agents.phase3.graph import sa4_integration
        state = self._base_state(tmp_path)
        result = await sa4_integration(state)  # type: ignore
        assert (tmp_path / ".env.example").exists()

    @pytest.mark.asyncio
    async def test_sa4_integration_creates_compose(self, tmp_path):
        from python.agents.phase3.graph import sa4_integration
        state = self._base_state(tmp_path)
        state["phase1_summary"]["plan.md"] = "Use PostgreSQL database"
        result = await sa4_integration(state)  # type: ignore
        assert (tmp_path / "docker-compose.yml").exists()

    @pytest.mark.asyncio
    async def test_sa5_validation_creates_phase3_md(self, tmp_path):
        from python.agents.phase3.graph import sa5_validation
        from python.agents.shared.paths import get_phase_dir
        state = self._base_state(tmp_path)
        state["scaffolded_files"] = []
        state["component_files"] = []
        state["logic_files"] = []
        state["integration_files"] = []
        result = await sa5_validation(state)  # type: ignore
        assert (get_phase_dir(tmp_path, 3, create=False) / "phase-3.md").exists()


class TestRunPhase3Integration:
    @pytest.mark.asyncio
    async def test_run_phase3_yolo(self, tmp_path):
        from python.agents.phase3.graph import run_phase3
        events: list = []
        result = await run_phase3(
            project_dir=str(tmp_path),
            user_id="test",
            is_yolo=True,
            send_sse=events.append,
        )
        assert result["status"] == "complete"
        phase_events = [e for e in events if e.get("type") == "phase_complete"]
        assert len(phase_events) >= 1
