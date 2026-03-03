"""
phase4_auto_retry.py — Phase 4 Auto-Retry / Auto-Remediation

This module provides automatic retry capabilities when Phase 4 security
testing finds issues - automatically triggering Phase 3 subagents to fix them.

Features:
- Retry policy configuration (max retries, categories)
- Issue -> patch plan generation
- Partial re-run (only affected subagents)
- Retry history tracking
"""
from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class RetryCategory(Enum):
    """Categories of issues that can trigger retries."""
    LINT = "lint"
    TEST = "test"
    SECURITY = "security"
    REGRESSION = "regression"
    PERFORMANCE = "performance"
    ACCESSIBILITY = "accessibility"


class RetryStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    SUCCESS = "success"
    FAILED = "failed"
    MAX_RETRIES_EXCEEDED = "max_retries_exceeded"


@dataclass
class Issue:
    """Represents a security/testing issue found in Phase 4."""
    id: str
    category: RetryCategory
    severity: str  # "critical", "high", "medium", "low"
    title: str
    description: str
    file_path: str | None = None
    line_number: int | None = None
    tool: str | None = None  # Which tool found the issue
    suggestion: str | None = None  # AI-generated fix suggestion


@dataclass
class PatchPlan:
    """Plan for fixing issues discovered in Phase 4."""
    id: str
    issue_id: str
    category: RetryCategory
    affected_files: list[str]
    affected_subagents: list[str]  # Which Phase 3 subagents to run
    instructions: str
    estimated_impact: str


@dataclass
class RetryAttempt:
    """A single retry attempt."""
    id: str
    patch_id: str
    attempt_number: int
    status: RetryStatus
    started_at: datetime
    completed_at: datetime | None = None
    subagent_results: list[dict] = field(default_factory=list)
    error_message: str | None = None


@dataclass
class RetryPolicy:
    """Configuration for retry behavior."""
    max_retries: int = 3
    enabled_categories: list[RetryCategory] = field(
        default_factory=lambda: [
            RetryCategory.LINT,
            RetryCategory.TEST,
            RetryCategory.SECURITY,
        ]
    )
    # Minimum severity to trigger retry (only for SECURITY category)
    min_security_severity: str = "high"
    # Whether to auto-approve patches
    auto_approve: bool = False
    # Parallel or sequential subagent execution
    parallel_execution: bool = True


@dataclass
class RetrySession:
    """Manages retry state for a Phase 4 -> Phase 3 session."""
    id: str
    phase4_session_id: str
    policy: RetryPolicy
    issues: list[Issue] = field(default_factory=list)
    patch_plans: list[PatchPlan] = field(default_factory=list)
    attempts: list[RetryAttempt] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)


class Phase4AutoRetry:
    """
    Manages automatic retry/fix workflows from Phase 4 back to Phase 3.

    Usage:
        auto_retry = Phase4AutoRetry(project_dir=".")
        session = await auto_retry.create_session(phase4_session_id)
        await auto_retry.add_issues(session, security_findings)
        await auto_retry.generate_patches(session)
        await auto_retry.execute_patches(session)
    """

    def __init__(
        self,
        project_dir: str = ".",
        policy: RetryPolicy | None = None,
    ):
        self.project_dir = project_dir
        self.policy = policy or RetryPolicy()
        self.sessions: dict[str, RetrySession] = {}

    # -------------------------------------------------------------------------
    # Session Management
    # -------------------------------------------------------------------------

    def create_session(
        self,
        phase4_session_id: str,
        policy: RetryPolicy | None = None,
    ) -> RetrySession:
        """Create a new retry session."""
        session = RetrySession(
            id=str(uuid.uuid4())[:8],
            phase4_session_id=phase4_session_id,
            policy=policy or self.policy,
        )
        self.sessions[session.id] = session
        return session

    def get_session(self, session_id: str) -> RetrySession | None:
        """Get a retry session by ID."""
        return self.sessions.get(session_id)

    def get_session_by_phase4_id(self, phase4_session_id: str) -> RetrySession | None:
        """Get a retry session by Phase 4 session ID."""
        for session in self.sessions.values():
            if session.phase4_session_id == phase4_session_id:
                return session
        return None

    # -------------------------------------------------------------------------
    # Issue Processing
    # -------------------------------------------------------------------------

    def add_issues(
        self,
        session_id: str,
        findings: list[dict],
    ) -> list[Issue]:
        """Add issues from Phase 4 findings."""
        session = self.get_session(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        issues = []

        for finding in findings:
            # Determine category based on tool
            tool = finding.get("tool", "")
            if tool in ("semgrep", "bandit", "gitleaks", "zap", "nikto", "sqlmap"):
                category = RetryCategory.SECURITY
            elif tool in ("eslint", "pylint", "ruff"):
                category = RetryCategory.LINT
            elif tool in ("pytest", "jest", "test"):
                category = RetryCategory.TEST
            else:
                category = RetryCategory.REGRESSION

            # Skip if category not enabled
            if category not in session.policy.enabled_categories:
                continue

            # Skip low severity if security
            if category == RetryCategory.SECURITY:
                severity = finding.get("severity", "low")
                severity_order = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}
                min_sev = session.policy.min_security_severity
                if severity_order.get(severity, 0) < severity_order.get(min_sev, 3):
                    continue

            issue = Issue(
                id=str(uuid.uuid4())[:8],
                category=category,
                severity=finding.get("severity", "medium"),
                title=finding.get("title", finding.get("rule", "Unknown issue")),
                description=finding.get("description", ""),
                file_path=finding.get("file_path", finding.get("path")),
                line_number=finding.get("line_number", finding.get("line")),
                tool=tool,
                suggestion=finding.get("suggestion"),
            )
            issues.append(issue)
            session.issues.append(issue)

        return issues

    # -------------------------------------------------------------------------
    # Patch Plan Generation
    # -------------------------------------------------------------------------

    async def generate_patches(self, session_id: str) -> list[PatchPlan]:
        """Generate patch plans for all eligible issues."""
        session = self.get_session(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        patch_plans = []

        # Group issues by category
        issues_by_category: dict[RetryCategory, list[Issue]] = {}
        for issue in session.issues:
            if issue.category not in issues_by_category:
                issues_by_category[issue.category] = []
            issues_by_category[issue.category].append(issue)

        # Generate patch plans based on category
        for category, issues in issues_by_category.items():
            # Determine which subagents to run based on category
            subagents = self._get_subagents_for_category(category)

            # Collect affected files
            affected_files = list(set(
                issue.file_path for issue in issues
                if issue.file_path
            ))

            # Generate instructions based on issues
            instructions = self._generate_instructions(category, issues)

            patch = PatchPlan(
                id=str(uuid.uuid4())[:8],
                issue_id=",".join(i.id for i in issues),
                category=category,
                affected_files=affected_files,
                affected_subagents=subagents,
                instructions=instructions,
                estimated_impact=f"{len(issues)} issue(s) in {len(affected_files)} file(s)",
            )

            patch_plans.append(patch)
            session.patch_plans.append(patch)

        return patch_plans

    def _get_subagents_for_category(self, category: RetryCategory) -> list[str]:
        """Determine which Phase 3 subagents to run for a category."""
        mapping = {
            RetryCategory.LINT: ["subagent-1", "subagent-4"],  # Frontend + Debug
            RetryCategory.TEST: ["subagent-4"],  # Debug/Testing
            RetryCategory.SECURITY: ["subagent-4"],  # Debug/Testing
            RetryCategory.REGRESSION: ["subagent-3", "subagent-4"],  # Integration + Debug
            RetryCategory.PERFORMANCE: ["subagent-2", "subagent-4"],  # Backend + Debug
            RetryCategory.ACCESSIBILITY: ["subagent-1"],  # Frontend
        }
        return mapping.get(category, ["subagent-4"])

    def _generate_instructions(
        self,
        category: RetryCategory,
        issues: list[Issue],
    ) -> str:
        """Generate instructions for fixing issues."""
        category_names = {
            RetryCategory.LINT: "linting issues",
            RetryCategory.TEST: "failing tests",
            RetryCategory.SECURITY: "security vulnerabilities",
            RetryCategory.REGRESSION: "regression issues",
            RetryCategory.PERFORMANCE: "performance problems",
            RetryCategory.ACCESSIBILITY: "accessibility issues",
        }

        instructions = f"Fix the following {category_names.get(category, 'issues')}:\n\n"

        for i, issue in enumerate(issues[:10], 1):  # Limit to 10 issues
            instructions += f"{i}. **{issue.title}**"
            if issue.file_path:
                instructions += f" in `{issue.file_path}`"
                if issue.line_number:
                    instructions += f" (line {issue.line_number})"
            instructions += f"\n   Severity: {issue.severity}\n"
            if issue.description:
                instructions += f"   {issue.description[:200]}\n"
            if issue.suggestion:
                instructions += f"   Suggested fix: {issue.suggestion[:200]}\n"
            instructions += "\n"

        return instructions

    # -------------------------------------------------------------------------
    # Patch Execution
    # -------------------------------------------------------------------------

    async def execute_patches(
        self,
        session_id: str,
        patch_ids: list[str] | None = None,
    ) -> list[RetryAttempt]:
        """Execute patch plans."""
        session = self.get_session(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        # Get patches to execute
        patches = session.patch_plans
        if patch_ids:
            patches = [p for p in patches if p.id in patch_ids]

        attempts = []

        for patch in patches:
            # Check if max retries exceeded
            existing_attempts = [
                a for a in session.attempts if a.patch_id == patch.id
            ]
            if len(existing_attempts) >= session.policy.max_retries:
                attempt = RetryAttempt(
                    id=str(uuid.uuid4())[:8],
                    patch_id=patch.id,
                    attempt_number=len(existing_attempts) + 1,
                    status=RetryStatus.MAX_RETRIES_EXCEEDED,
                    started_at=datetime.utcnow(),
                    completed_at=datetime.utcnow(),
                    error_message="Max retries exceeded",
                )
                attempts.append(attempt)
                session.attempts.append(attempt)
                continue

            # Create new attempt
            attempt = RetryAttempt(
                id=str(uuid.uuid4())[:8],
                patch_id=patch.id,
                attempt_number=len(existing_attempts) + 1,
                status=RetryStatus.IN_PROGRESS,
                started_at=datetime.utcnow(),
            )
            session.attempts.append(attempt)

            try:
                # Execute subagents based on patch
                results = await self._execute_subagents(patch)
                attempt.subagent_results = results
                attempt.status = RetryStatus.SUCCESS
            except Exception as e:
                attempt.status = RetryStatus.FAILED
                attempt.error_message = str(e)

            attempt.completed_at = datetime.utcnow()
            attempts.append(attempt)

        return attempts

    async def _execute_subagents(self, patch: PatchPlan) -> list[dict]:
        """Execute the subagents required by a patch plan."""
        results = []

        # This would integrate with the Phase 3 pipeline
        # For now, we'll generate the commands that would be executed

        for subagent in patch.affected_subagents:
            result = {
                "subagent": subagent,
                "category": patch.category.value,
                "files": patch.affected_files,
                "instructions": patch.instructions,
                "status": "ready_to_execute",  # In real implementation, would execute
            }
            results.append(result)

        return results

    # -------------------------------------------------------------------------
    # Status and History
    # -------------------------------------------------------------------------

    def get_status(self, session_id: str) -> dict:
        """Get status of a retry session."""
        session = self.get_session(session_id)
        if not session:
            return {"error": "Session not found"}

        total_attempts = len(session.attempts)
        successful = sum(
            1 for a in session.attempts
            if a.status == RetryStatus.SUCCESS
        )
        failed = sum(
            1 for a in session.attempts
            if a.status in (RetryStatus.FAILED, RetryStatus.MAX_RETRIES_EXCEEDED)
        )

        return {
            "session_id": session.id,
            "phase4_session_id": session.phase4_session_id,
            "issues_count": len(session.issues),
            "patches_count": len(session.patch_plans),
            "total_attempts": total_attempts,
            "successful": successful,
            "failed": failed,
            "pending": total_attempts - successful - failed,
        }

    def get_retry_history(
        self,
        session_id: str,
        limit: int = 10,
    ) -> list[dict]:
        """Get retry history for a session."""
        session = self.get_session(session_id)
        if not session:
            return []

        return [
            {
                "id": a.id,
                "patch_id": a.patch_id,
                "attempt_number": a.attempt_number,
                "status": a.status.value,
                "started_at": a.started_at.isoformat(),
                "completed_at": a.completed_at.isoformat() if a.completed_at else None,
                "error": a.error_message,
            }
            for a in session.attempts[-limit:]
        ]


# -------------------------------------------------------------------------
# Bridge Server Integration
# -------------------------------------------------------------------------

_auto_retry_instance = None


def get_auto_retry(project_dir: str = ".") -> Phase4AutoRetry:
    """Get or create the auto-retry instance."""
    global _auto_retry_instance
    if _auto_retry_instance is None:
        _auto_retry_instance = Phase4AutoRetry(project_dir)
    return _auto_retry_instance


async def cmd_auto_retry_create(phase4_session_id: str) -> dict:
    """Create a new auto-retry session."""
    auto_retry = get_auto_retry()
    session = auto_retry.create_session(phase4_session_id)
    return {"session_id": session.id}


async def cmd_auto_retry_add_issues(session_id: str, findings: list[dict]) -> dict:
    """Add issues to a retry session."""
    auto_retry = get_auto_retry()
    issues = auto_retry.add_issues(session_id, findings)
    return {
        "session_id": session_id,
        "issues_added": len(issues),
    }


async def cmd_auto_retry_generate_patches(session_id: str) -> dict:
    """Generate patch plans."""
    auto_retry = get_auto_retry()
    patches = await auto_retry.generate_patches(session_id)
    return {
        "session_id": session_id,
        "patches_generated": len(patches),
        "patches": [
            {
                "id": p.id,
                "category": p.category.value,
                "affected_files": p.affected_files,
                "affected_subagents": p.affected_subagents,
            }
            for p in patches
        ],
    }


async def cmd_auto_retry_execute(
    session_id: str,
    patch_ids: list[str] | None = None,
) -> dict:
    """Execute patches."""
    auto_retry = get_auto_retry()
    attempts = await auto_retry.execute_patches(session_id, patch_ids)
    return {
        "session_id": session_id,
        "attempts": len(attempts),
        "results": [
            {
                "id": a.id,
                "patch_id": a.patch_id,
                "attempt_number": a.attempt_number,
                "status": a.status.value,
                "error": a.error_message,
            }
            for a in attempts
        ],
    }


async def cmd_auto_retry_status(session_id: str) -> dict:
    """Get retry session status."""
    auto_retry = get_auto_retry()
    return auto_retry.get_status(session_id)


async def cmd_auto_retry_history(session_id: str, limit: int = 10) -> dict:
    """Get retry history."""
    auto_retry = get_auto_retry()
    history = auto_retry.get_retry_history(session_id, limit)
    return {"session_id": session_id, "history": history}
