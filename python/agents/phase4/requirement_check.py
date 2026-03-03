"""
requirement_check.py — Phase 4 RequirementChecker.
T117: Verify implemented features against user-stories.md and prd.md from Phase 1.
Returns structured pass/fail checklist.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
from typing import Any, TypedDict

from ..shared.paths import get_phase_dir


# ---------------------------------------------------------------------------
# T117 Deterministic structured check types
# ---------------------------------------------------------------------------

class RequirementItem(TypedDict):
    """A single deterministic requirement check result."""
    id: str           # stable ID derived from category + index
    category: str     # user_stories | prd | tasks
    requirement: str  # original requirement text
    status: str       # "pass" | "fail"
    coverage: float   # 0.0 – 1.0
    matched_keywords: list[str]   # keywords found in source
    missing_keywords: list[str]   # keywords NOT found in source


class RequirementChecker:
    """
    Compares implemented files against Phase 1 requirements (user-stories.md, prd.md).
    """

    def __init__(self, project_dir: str = "."):
        self.project_dir = pathlib.Path(project_dir)
        self.phase1_dir = get_phase_dir(self.project_dir, 1, create=False)

    # ------------------------------------------------------------------

    def load_requirements(self) -> dict[str, list[str]]:
        """Load user stories and PRD requirements from phase-1 files."""
        reqs: dict[str, list[str]] = {"user_stories": [], "prd": [], "tasks": []}

        stories_path = self.phase1_dir / "user-stories.md"
        prd_path = self.phase1_dir / "prd.md"
        tasks_path = self.phase1_dir / "tasks.md"

        if stories_path.exists():
            text = stories_path.read_text()
            # Extract "As a X, I want Y" patterns
            reqs["user_stories"] = re.findall(r"As a .+?(?=\n|$)", text)[:50]

        if prd_path.exists():
            text = prd_path.read_text()
            # Extract checkbox items or bullet items
            reqs["prd"] = re.findall(r"[-*•]\s+(.+)", text)[:50]

        if tasks_path.exists():
            text = tasks_path.read_text()
            reqs["tasks"] = re.findall(r"- \[[ xX]\]\s+(.+)", text)[:50]

        return reqs

    # ------------------------------------------------------------------

    def check_file_coverage(self, requirements: list[str]) -> list[dict]:
        """Check which requirements have matching implementation files."""
        source_files: list[pathlib.Path] = []
        for ext in (".ts", ".tsx", ".py", ".js", ".jsx"):
            source_files += [
                f for f in self.project_dir.rglob(f"*{ext}")
                if "node_modules" not in str(f) and ".git" not in str(f) and "phase-" not in str(f)
            ]

        # Build searchable text from all sources
        combined_source = ""
        for f in source_files[:200]:
            try:
                combined_source += f.read_text(errors="ignore")[:500]
            except Exception:
                pass

        results: list[dict] = []
        for req in requirements:
            # Extract key nouns/verbs from requirement
            words = [w.lower() for w in re.findall(r"\b[a-zA-Z]{4,}\b", req)]
            matches = sum(1 for w in words if w in combined_source.lower())
            coverage = min(matches / max(len(words), 1), 1.0)
            results.append({
                "requirement": req,
                "status": "pass" if coverage >= 0.3 else "fail",
                "coverage": round(coverage, 2),
            })
        return results

    # ------------------------------------------------------------------

    def run(self) -> dict[str, Any]:
        """Run full requirement check and return structured results."""
        reqs = self.load_requirements()
        all_checks: list[dict] = []

        for category, req_list in reqs.items():
            checks = self.check_file_coverage(req_list)
            for c in checks:
                c["category"] = category
            all_checks.extend(checks)

        passed = sum(1 for c in all_checks if c["status"] == "pass")
        total = len(all_checks)
        pass_rate = passed / max(total, 1)

        return {
            "checks": all_checks,
            "summary": {
                "total": total,
                "passed": passed,
                "failed": total - passed,
                "pass_rate": round(pass_rate, 2),
                "met_threshold": pass_rate >= 0.7,
            },
        }


    # ------------------------------------------------------------------
    # T117: Deterministic structured pass/fail
    # ------------------------------------------------------------------

    def check_deterministic(self, requirements: list[str], category: str) -> list[RequirementItem]:
        """
        Deterministic structured pass/fail for a list of requirements.
        Unlike check_file_coverage(), this returns RequirementItem TypedDicts with
        explicit matched/missing keyword lists for full traceability.
        """
        source_files: list[pathlib.Path] = []
        for ext in (".ts", ".tsx", ".py", ".js", ".jsx"):
            source_files += [
                f for f in self.project_dir.rglob(f"*{ext}")
                if "node_modules" not in str(f) and ".git" not in str(f) and "phase-" not in str(f)
            ]
        combined_source = ""
        for f in source_files[:200]:
            try:
                combined_source += f.read_text(errors="ignore")[:500]
            except Exception:
                pass
        source_lower = combined_source.lower()

        items: list[RequirementItem] = []
        for idx, req in enumerate(requirements):
            words = [w.lower() for w in re.findall(r"\b[a-zA-Z]{4,}\b", req)]
            matched = [w for w in words if w in source_lower]
            missing = [w for w in words if w not in source_lower]
            coverage = min(len(matched) / max(len(words), 1), 1.0)
            items.append(RequirementItem(
                id=f"{category}-{idx:03d}",
                category=category,
                requirement=req,
                status="pass" if coverage >= 0.3 else "fail",
                coverage=round(coverage, 2),
                matched_keywords=matched,
                missing_keywords=missing,
            ))
        return items

    def run_structured(self) -> dict[str, Any]:
        """
        Run deterministic structured pass/fail check and return RequirementItem list.
        This is the structured counterpart of run() — fully typed, traceable,
        and suitable for programmatic consumption by downstream tools.
        """
        reqs = self.load_requirements()
        all_items: list[RequirementItem] = []

        for category, req_list in reqs.items():
            items = self.check_deterministic(req_list, category=category)
            all_items.extend(items)

        passed = sum(1 for item in all_items if item["status"] == "pass")
        total = len(all_items)
        pass_rate = passed / max(total, 1)

        return {
            "items": all_items,
            "summary": {
                "total": total,
                "passed": passed,
                "failed": total - passed,
                "pass_rate": round(pass_rate, 2),
                "met_threshold": pass_rate >= 0.7,
            },
        }

    def write_report(self, output_path: str | None = None) -> str:
        """Write markdown report of requirement checks."""
        result = self.run()
        summary = result["summary"]
        rows = ""
        for c in result["checks"]:
            icon = "✅" if c["status"] == "pass" else "❌"
            rows += f"| {icon} | {c['category']} | {c['requirement'][:80]} | {c['coverage']:.0%} |\n"

        md = f"""# Requirement Coverage Report

## Summary

| Metric | Value |
|--------|-------|
| Total Requirements | {summary['total']} |
| Passed | {summary['passed']} |
| Failed | {summary['failed']} |
| Pass Rate | {summary['pass_rate']:.0%} |
| Threshold Met (≥70%) | {'✅ Yes' if summary['met_threshold'] else '❌ No'} |

## Details

| Status | Category | Requirement | Coverage |
|--------|----------|-------------|----------|
{rows}
"""
        out = pathlib.Path(output_path) if output_path else get_phase_dir(self.project_dir, 4) / "requirement-coverage.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(md)
        return str(out)
