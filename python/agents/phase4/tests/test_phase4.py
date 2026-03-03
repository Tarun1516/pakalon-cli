"""
test_phase4.py — Tests for Phase 4 security QA agent.
T119: SASTRunner, DASTRunner, XmlReportGenerator, RequirementChecker, graph nodes.
"""
from __future__ import annotations

import json
import pathlib
import sys
import xml.etree.ElementTree as ET

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parents[4]))


class TestSASTRunner:
    def test_import(self):
        from python.agents.phase4.sast import SASTRunner  # noqa: F401

    def test_secrets_grep_detects_api_key(self, tmp_path):
        from python.agents.phase4.sast import SASTRunner
        (tmp_path / "config.ts").write_text('const API_KEY = "sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD";')
        runner = SASTRunner(project_dir=str(tmp_path))
        result = runner._run_secrets_grep()
        assert result["available"] is True
        # Should detect the openai-style key
        assert any("key" in f.get("rule", "").lower() or "openai" in f.get("rule", "").lower() for f in result["findings"])

    def test_secrets_grep_clean_code(self, tmp_path):
        from python.agents.phase4.sast import SASTRunner
        (tmp_path / "clean.ts").write_text("export const greet = (name: string) => `Hello ${name}`;")
        runner = SASTRunner(project_dir=str(tmp_path))
        result = runner._run_secrets_grep()
        assert result["findings"] == []

    def test_run_all_returns_summary(self, tmp_path):
        from python.agents.phase4.sast import SASTRunner
        runner = SASTRunner(project_dir=str(tmp_path))
        result = runner.run_all()
        assert "summary" in result
        assert "total_findings" in result["summary"]
        assert "passed" in result["summary"]

    def test_gitleaks_fallback(self, tmp_path):
        from python.agents.phase4.sast import SASTRunner
        runner = SASTRunner(project_dir=str(tmp_path))
        result = runner._run_gitleaks()
        # Either available or not installed — both are valid
        assert isinstance(result["findings"], list)

    def test_bandit_no_python_files(self, tmp_path):
        from python.agents.phase4.sast import SASTRunner
        runner = SASTRunner(project_dir=str(tmp_path))
        result = runner._run_bandit()
        assert result["available"] is True
        assert result["findings"] == []


class TestDASTRunner:
    def test_import(self):
        from python.agents.phase4.dast import DASTRunner  # noqa: F401

    def test_check_headers_unavailable_host(self):
        from python.agents.phase4.dast import DASTRunner
        runner = DASTRunner(target_url="http://localhost:19999")
        result = runner._check_security_headers()
        # Should fail gracefully
        assert isinstance(result.get("missing", []), list)

    def test_run_all_returns_summary(self):
        from python.agents.phase4.dast import DASTRunner
        runner = DASTRunner(target_url="http://localhost:19999")
        result = runner.run_all()
        assert "summary" in result
        assert "total_findings" in result["summary"]

    def test_nmap_fallback(self):
        from python.agents.phase4.dast import DASTRunner
        runner = DASTRunner(target_url="http://localhost:19999")
        result = runner._run_nmap()
        assert isinstance(result.get("open_ports", []), list)


class TestXmlReportGenerator:
    def test_import(self):
        from python.agents.phase4.xml_reports import XmlReportGenerator  # noqa: F401

    def test_generate_whitebox_valid_xml(self, tmp_path):
        from python.agents.phase4.xml_reports import XmlReportGenerator
        gen = XmlReportGenerator(output_dir=str(tmp_path))
        sast = {
            "secrets_grep": {"findings": [{"rule": "api_key", "path": "app.py", "line": 5, "message": "Found key", "severity": "HIGH"}]},
            "summary": {"total_findings": 1, "high_severity": 1, "passed": False},
        }
        path = gen.generate_whitebox(sast)
        assert pathlib.Path(path).exists()
        tree = ET.parse(path)
        assert tree.getroot().tag == "testsuite"

    def test_generate_blackbox_valid_xml(self, tmp_path):
        from python.agents.phase4.xml_reports import XmlReportGenerator
        gen = XmlReportGenerator(output_dir=str(tmp_path))
        dast = {
            "security_headers": {"missing": ["CSP", "HSTS"], "present": []},
            "zap": {"alerts": []},
            "summary": {"total_findings": 2, "high_severity": 0, "passed": True},
        }
        path = gen.generate_blackbox(dast)
        assert pathlib.Path(path).exists()

    def test_generate_html_creates_file(self, tmp_path):
        from python.agents.phase4.xml_reports import XmlReportGenerator
        gen = XmlReportGenerator(output_dir=str(tmp_path))
        sast = {"summary": {"total_findings": 0, "high_severity": 0, "passed": True}}
        dast = {"summary": {"total_findings": 0, "high_severity": 0, "passed": True}}
        path = gen.generate_html(sast, dast)
        assert pathlib.Path(path).exists()
        content = pathlib.Path(path).read_text()
        assert "PASS" in content or "FAIL" in content


class TestRequirementChecker:
    def test_import(self):
        from python.agents.phase4.requirement_check import RequirementChecker  # noqa: F401

    def test_run_no_phase1(self, tmp_path):
        from python.agents.phase4.requirement_check import RequirementChecker
        checker = RequirementChecker(project_dir=str(tmp_path))
        result = checker.run()
        assert "summary" in result
        assert result["summary"]["total"] == 0

    def test_run_with_user_stories(self, tmp_path):
        from python.agents.phase4.requirement_check import RequirementChecker
        from python.agents.shared.paths import get_phase_dir
        phase1 = get_phase_dir(tmp_path, 1)
        phase1.mkdir(parents=True, exist_ok=True)
        (phase1 / "user-stories.md").write_text("As a user, I want to login\nAs a user, I want to logout\n")
        (tmp_path / "auth.ts").write_text("export function login() {}\nexport function logout() {}")
        checker = RequirementChecker(project_dir=str(tmp_path))
        result = checker.run()
        assert result["summary"]["total"] == 2

    def test_write_report(self, tmp_path):
        from python.agents.phase4.requirement_check import RequirementChecker
        from python.agents.shared.paths import get_phase_dir
        phase1 = get_phase_dir(tmp_path, 1)
        phase1.mkdir(parents=True, exist_ok=True)
        (phase1 / "user-stories.md").write_text("As a user, I want to register\n")
        checker = RequirementChecker(project_dir=str(tmp_path))
        path = checker.write_report()
        assert pathlib.Path(path).exists()


class TestRunPhase4Integration:
    @pytest.mark.asyncio
    async def test_run_phase4_yolo(self, tmp_path):
        from python.agents.phase4.graph import run_phase4
        events: list = []
        result = await run_phase4(
            project_dir=str(tmp_path),
            target_url="http://localhost:19999",
            is_yolo=True,
            send_sse=events.append,
        )
        assert result["status"] == "complete"
        phase_events = [e for e in events if e.get("type") == "phase_complete"]
        assert len(phase_events) >= 1
        # Reports should be generated
        from python.agents.shared.paths import get_phase_dir
        phase4_dir = get_phase_dir(tmp_path, 4, create=False)
        assert phase4_dir.exists()
        assert (phase4_dir / "phase-4.md").exists()
