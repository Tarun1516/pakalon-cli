"""
phase4_auto_retry.py — Phase 4 Auto-Retry / Re-run Phase 3

This module implements automatic remediation when Phase 4 QA finds issues:
- Retry policy configuration (max retries, categories)
- Issue-to-patch plan generation for Phase 3 subagents
- Partial re-run (only affected subagent + targeted files)
- Retry history persistence
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any


class RetryCategory(Enum):
    """Categories of issues that can trigger retries."""
    LINT = "lint"
    TEST = "test"
    SECURITY = "security"
    REGRESSION = "regression"
    BUILD = "build"
    TYPE_CHECK = "type_check"


class RetryDecision(Enum):
    """Decision on whether to retry."""
    AUTO_RETRY = "auto_retry"
    MANUAL_REVIEW = "manual_review"
    SKIP = "skip"


@dataclass
class RetryPolicy:
    """Policy for automatic retries."""
    max_retries: int = 3
    retry_lint: bool = True
    retry_test: bool = True
    retry_security: bool = True
    retry_regression: bool = False
    retry_build: bool = True
    auto_retry_delay_seconds: int = 5


@dataclass
class Phase4Finding:
    """Represents a single finding from Phase 4."""
    category: RetryCategory
    severity: str  # CRITICAL, HIGH, MEDIUM, LOW
    tool: str  # semgrep, bandit, zap, etc.
    file_path: str | None
    line_number: int | None
    message: str
    rule_id: str | None
    suggestion: str | None = None


@dataclass
class RetryTask:
    """Represents a task to be retried in Phase 3."""
    subagent: str  # subagent-1, subagent-2, etc.
    files: list[str] = field(default_factory=list)
    reason: str = ""
    category: RetryCategory = RetryCategory.SECURITY


@dataclass
class RetryResult:
    """Result of a retry attempt."""
    retry_id: str
    original_finding: Phase4Finding
    retry_task: RetryTask
    status: str  # pending, in_progress, success, failed
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None
    patches_applied: list[str] = field(default_factory=list)


@dataclass
class AutoRetryState:
    """Tracks the auto-retry state for a project."""
    retries: list[RetryResult] = field(default_factory=list)
    total_retries: int = 0
    successful_retries: int = 0
    failed_retries: int = 0


class Phase4AutoRetry:
    """
    Manages automatic Phase 3 retries based on Phase 4 findings.

    Usage:
        auto_retry = Phase4AutoRetry(project_dir=".")
        decisions = await auto_retry.analyze_findings(phase4_report)
        for decision in decisions:
            if decision.should_retry:
                result = await auto_retry.execute_retry(decision)
    """

    def __init__(
        self,
        project_dir: str = ".",
        policy: RetryPolicy | None = None,
        state_file: str = ".pakalon-agents/ai-agents/phase-4/auto-retry-state.json",
    ):
        self.project_dir = Path(project_dir)
        self.state_file = self.project_dir / state_file
        self.policy = policy or RetryPolicy()
        self.state = self._load_state()

    # -------------------------------------------------------------------------
    # State Management
    # -------------------------------------------------------------------------

    def _load_state(self) -> AutoRetryState:
        """Load retry state from file."""
        if not self.state_file.exists():
            return AutoRetryState()

        try:
            with open(self.state_file) as f:
                data = json.load(f)
                return AutoRetryState(
                    retries=[
                        RetryResult(
                            retry_id=r["retry_id"],
                            original_finding=Phase4Finding(
                                category=RetryCategory(r["category"]),
                                severity=r["severity"],
                                tool=r["tool"],
                                file_path=r.get("file_path"),
                                line_number=r.get("line_number"),
                                message=r["message"],
                                rule_id=r.get("rule_id"),
                            ),
                            retry_task=RetryTask(
                                subagent=r["subagent"],
                                files=r.get("files", []),
                                reason=r.get("reason", ""),
                                category=RetryCategory(r.get("category", "security")),
                            ),
                            status=r["status"],
                        )
                        for r in data.get("retries", [])
                    ],
                    total_retries=data.get("total_retries", 0),
                    successful_retries=data.get("successful_retries", 0),
                    failed_retries=data.get("failed_retries", 0),
                )
        except Exception:
            return AutoRetryState()

    def _save_state(self):
        """Save retry state to file."""
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "retries": [
                {
                    "retry_id": r.retry_id,
                    "category": r.retry_task.category.value,
                    "severity": r.original_finding.severity,
                    "tool": r.original_finding.tool,
                    "file_path": r.original_finding.file_path,
                    "line_number": r.original_finding.line_number,
                    "message": r.original_finding.message,
                    "rule_id": r.original_finding.rule_id,
                    "subagent": r.retry_task.subagent,
                    "files": r.retry_task.files,
                    "reason": r.retry_task.reason,
                    "status": r.status,
                }
                for r in self.state.retries
            ],
            "total_retries": self.state.total_retries,
            "successful_retries": self.state.successful_retries,
            "failed_retries": self.state.failed_retries,
        }
        with open(self.state_file, "w") as f:
            json.dump(data, f, indent=2)

    # -------------------------------------------------------------------------
    # Analysis
    # -------------------------------------------------------------------------

    def analyze_findings(self, phase4_report: dict) -> list[RetryTask]:
        """
        Analyze Phase 4 findings and determine which require retries.

        Returns a list of RetryTask objects that should be executed.
        """
        tasks: list[RetryTask] = []

        # Check SAST findings
        sast_results = phase4_report.get("sast", {})
        for tool_name, tool_result in sast_results.items():
            if not isinstance(tool_result, dict):
                continue

            findings = tool_result.get("findings", [])
            for finding in findings:
                task = self._create_retry_task(
                    category=RetryCategory.SECURITY,
                    severity=finding.get("severity", "LOW"),
                    tool=tool_name,
                    file_path=finding.get("path"),
                    line_number=finding.get("line"),
                    message=finding.get("message", ""),
                    rule_id=finding.get("rule"),
                )
                if task:
                    tasks.append(task)

        # Check DAST findings
        dast_results = phase4_report.get("dast", {})
        for tool_name, tool_result in dast_results.items():
            if not isinstance(tool_result, dict):
                continue

            findings = tool_result.get("findings", [])
            for finding in findings:
                task = self._create_retry_task(
                    category=RetryCategory.SECURITY,
                    severity=finding.get("severity", "MEDIUM"),
                    tool=tool_name,
                    file_path=finding.get("url"),  # DAST uses URL
                    line_number=None,
                    message=finding.get("message", ""),
                    rule_id=finding.get("name"),
                )
                if task:
                    tasks.append(task)

        # Check test failures
        test_results = phase4_report.get("tests", {})
        if test_results.get("failed", 0) > 0:
            for failure in test_results.get("failures", []):
                task = self._create_retry_task(
                    category=RetryCategory.TEST,
                    severity="HIGH",
                    tool="pytest",
                    file_path=failure.get("file"),
                    line_number=failure.get("line"),
                    message=failure.get("message", ""),
                    rule_id=None,
                )
                if task:
                    tasks.append(task)

        # Check lint failures
        lint_results = phase4_report.get("lint", {})
        if lint_results.get("failed", 0) > 0:
            for failure in lint_results.get("failures", []):
                task = self._create_retry_task(
                    category=RetryCategory.LINT,
                    severity="MEDIUM",
                    tool="eslint",
                    file_path=failure.get("file"),
                    line_number=failure.get("line"),
                    message=failure.get("message", ""),
                    rule_id=None,
                )
                if task:
                    tasks.append(task)

        return tasks

    def _create_retry_task(
        self,
        category: RetryCategory,
        severity: str,
        tool: str,
        file_path: str | None,
        line_number: int | None,
        message: str,
        rule_id: str | None,
    ) -> RetryTask | None:
        """Create a retry task from a finding if it meets retry criteria."""

        # Check if this category should be retried
        category_map = {
            RetryCategory.LINT: self.policy.retry_lint,
            RetryCategory.TEST: self.policy.retry_test,
            RetryCategory.SECURITY: self.policy.retry_security,
            RetryCategory.REGRESSION: self.policy.retry_regression,
            RetryCategory.BUILD: self.policy.retry_build,
        }

        if not category_map.get(category, False):
            return None

        # Check severity threshold
        severity_order = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1, "INFO": 0}
        if severity_order.get(severity.upper(), 0) < 2:  # Only MEDIUM and above
            return None

        # Check if we've exceeded max retries
        if self.state.total_retries >= self.policy.max_retries:
            return None

        # Determine which subagent to use based on category
        subagent_map = {
            RetryCategory.SECURITY: "subagent-4",  # Debug/Testing
            RetryCategory.TEST: "subagent-4",
            RetryCategory.LINT: "subagent-1",  # Frontend
            RetryCategory.BUILD: "subagent-3",  # Integration
            RetryCategory.REGRESSION: "subagent-5",  # Feedback
        }

        # Determine which files to target
        files = []
        if file_path:
            files = [file_path]

        return RetryTask(
            subagent=subagent_map.get(category, "subagent-4"),
            files=files,
            reason=f"{tool}: {message[:100]}",
            category=category,
        )

    # -------------------------------------------------------------------------
    # Execution
    # -------------------------------------------------------------------------

    async def execute_retry(self, task: RetryTask) -> RetryResult:
        """Execute a retry task in Phase 3."""
        import uuid

        retry_id = str(uuid.uuid4())[:8]

        result = RetryResult(
            retry_id=retry_id,
            original_finding=Phase4Finding(
                category=task.category,
                severity="MEDIUM",  # Default
                tool="auto-retry",
                file_path=task.files[0] if task.files else None,
                line_number=None,
                message=task.reason,
            ),
            retry_task=task,
            status="pending",
        )

        self.state.retries.append(result)
        self.state.total_retries += 1
        self._save_state()

        result.status = "in_progress"
        result.started_at = datetime.utcnow()

        try:
            # In a real implementation, this would trigger the Phase 3 subagent
            # via the bridge server
            # For now, we'll simulate the execution

            # Generate a patch plan based on the finding
            patch_plan = self._generate_patch_plan(task)

            # Apply patches (in real implementation, this would be done by Phase 3)
            applied = await self._apply_patches(patch_plan)
            result.patches_applied = applied

            result.status = "success"
            result.completed_at = datetime.utcnow()
            self.state.successful_retries += 1

        except Exception as e:
            result.status = "failed"
            result.error = str(e)
            result.completed_at = datetime.utcnow()
            self.state.failed_retries += 1

        self._save_state()
        return result

    def _generate_patch_plan(self, task: RetryTask) -> dict:
        """Generate a patch plan for the retry task."""
        return {
            "task": task.category.value,
            "files": task.files,
            "reason": task.reason,
            "subagent": task.subagent,
        }

    async def _apply_patches(self, patch_plan: dict) -> list[str]:
        """Apply patches based on the patch plan."""
        # In a real implementation, this would:
        # 1. Call the appropriate Phase 3 subagent
        # 2. Pass the finding details
        # 3. Get back the patches
        # 4. Apply them to the codebase
        # For now, return empty
        return []

    # -------------------------------------------------------------------------
    # Status and History
    # -------------------------------------------------------------------------

    def get_retry_status(self) -> dict:
        """Get current retry status."""
        return {
            "total_retries": self.state.total_retries,
            "successful_retries": self.state.successful_retries,
            "failed_retries": self.state.failed_retries,
            "success_rate": (
                self.state.successful_retries / self.state.total_retries
                if self.state.total_retries > 0
                else 0
            ),
            "recent_retries": [
                {
                    "id": r.retry_id,
                    "category": r.retry_task.category.value,
                    "subagent": r.retry_task.subagent,
                    "status": r.status,
                }
                for r in self.state.retries[-10:]
            ],
        }

    def clear_history(self):
        """Clear retry history."""
        self.state = AutoRetryState()
        self._save_state()


# -------------------------------------------------------------------------
# CLI Commands
# -------------------------------------------------------------------------

def create_auto_retry(project_dir: str = ".") -> Phase4AutoRetry:
    """Create a Phase4AutoRetry instance."""
    return Phase4AutoRetry(project_dir=project_dir)


async def cmd_auto_retry_status(project_dir: str = ".") -> dict:
    """Get auto-retry status."""
    auto_retry = create_auto_retry(project_dir)
    return auto_retry.get_retry_status()


async def cmd_auto_retry_execute(
    category: str,
    files: list[str],
    reason: str,
    project_dir: str = ".",
) -> dict:
    """Manually execute a retry."""
    auto_retry = create_auto_retry(project_dir)

    task = RetryTask(
        subagent="subagent-4",  # Default to testing subagent
        files=files,
        reason=reason,
        category=RetryCategory(category),
    )

    result = await auto_retry.execute_retry(task)

    return {
        "retry_id": result.retry_id,
        "status": result.status,
        "error": result.error,
    }


async def cmd_auto_retry_clear(project_dir: str = ".") -> dict:
    """Clear retry history."""
    auto_retry = create_auto_retry(project_dir)
    auto_retry.clear_history()
    return {"status": "cleared"}


async def cmd_auto_retry_analyze(
    phase4_report: dict,
    project_dir: str = ".",
) -> dict:
    """Analyze Phase 4 report and suggest retries."""
    auto_retry = create_auto_retry(project_dir)
    tasks = auto_retry.analyze_findings(phase4_report)

    return {
        "suggested_retries": [
            {
                "category": task.category.value,
                "subagent": task.subagent,
                "files": task.files,
                "reason": task.reason,
            }
            for task in tasks
        ],
        "total": len(tasks),
    }
