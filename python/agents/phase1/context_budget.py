"""
context_budget.py — Context window budget management for Phase 1.
T103: ContextBudget — allocates token budgets per phase/subagent.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any


class ContextBudget:
    """
    Manages LLM context window allocation across phases and subagents.

    HIL mode: Sends SSE choice_request to user for allocation approval.
    YOLO mode: Auto-assigns based on project type.

    Rules:
    - New project: >= 65% allocation to agent context
    - Existing project: >= 35% allocation
    - 10% buffer always reserved
    """

    # Default budget distributions (fractions of total context)
    PHASE_WEIGHTS_NEW = {
        "phase1": 0.08,
        "phase2": 0.08,
        "phase3_sa1": 0.12,  # Frontend
        "phase3_sa2": 0.12,  # Backend
        "phase3_sa3": 0.10,  # Integration
        "phase3_sa4": 0.10,  # Debug/Test
        "phase3_sa5": 0.08,  # Feedback
        "phase4": 0.12,
        "phase5": 0.06,
        "phase6": 0.04,
        "buffer": 0.10,
    }

    PHASE_WEIGHTS_EXISTING = {
        "phase1": 0.06,
        "phase2": 0.06,
        "phase3_sa1": 0.10,
        "phase3_sa2": 0.10,
        "phase3_sa3": 0.09,
        "phase3_sa4": 0.09,
        "phase3_sa5": 0.07,
        "phase4": 0.11,
        "phase5": 0.06,
        "phase6": 0.04,
        "user_reserved": 0.12,  # more for existing code
        "buffer": 0.10,
    }

    def __init__(
        self,
        total_context: int,
        is_new_project: bool = True,
        user_allocated_pct: float | None = None,
    ) -> None:
        self.total_context = total_context
        self.is_new_project = is_new_project
        self._user_pct = user_allocated_pct
        self._budgets: dict[str, int] = {}
        self._compute_budgets()

    # ------------------------------------------------------------------
    # Budget computation
    # ------------------------------------------------------------------

    def _compute_budgets(self) -> None:
        weights = self.PHASE_WEIGHTS_NEW if self.is_new_project else self.PHASE_WEIGHTS_EXISTING

        if self._user_pct is not None:
            # User specified a percentage — validate minimum
            min_pct = 0.65 if self.is_new_project else 0.35
            effective_pct = max(self._user_pct, min_pct)
            # Scale weights to fit user's allocation
            scale = effective_pct / (1.0 - weights.get("buffer", 0.10))
            self._budgets = {
                k: int(self.total_context * v * scale)
                for k, v in weights.items()
                if k != "buffer"
            }
        else:
            # Auto allocation
            self._budgets = {
                k: int(self.total_context * v)
                for k, v in weights.items()
            }

    def get(self, phase: str) -> int:
        """Get token budget for a phase/subagent key."""
        return self._budgets.get(phase, int(self.total_context * 0.05))

    def get_all(self) -> dict[str, int]:
        """Return all computed budgets."""
        return dict(self._budgets)

    def get_summary(self) -> str:
        """Human-readable budget summary."""
        lines = ["## Context Budget"]
        lines.append(f"Total context window: {self.total_context:,} tokens")
        lines.append(f"Project type: {'new' if self.is_new_project else 'existing'}")
        lines.append("")
        lines.append("| Phase | Tokens | % |")
        lines.append("|---|---|---|")
        for k, v in sorted(self._budgets.items()):
            pct = (v / self.total_context * 100) if self.total_context else 0
            lines.append(f"| {k} | {v:,} | {pct:.1f}% |")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # HIL interaction
    # ------------------------------------------------------------------

    @staticmethod
    def build_choice_request(is_new_project: bool) -> dict[str, Any]:
        """Build an SSE choice_request event for HIL context allocation."""
        min_pct = 65 if is_new_project else 35
        return {
            "type": "choice_request",
            "question": f"How much of the context window should be allocated to agent work? (minimum {min_pct}%)",
            "choices": [
                {"id": "auto", "label": f"Auto ({70 if is_new_project else 50}%)"},
                {"id": "65", "label": "65%"},
                {"id": "75", "label": "75%"},
                {"id": "85", "label": "85%"},
                {"id": "custom", "label": "Custom percentage"},
            ],
        }

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------

    def write_context_management_md(self, output_path: str) -> str:
        """Write context_management.md. Returns path."""
        content = self.get_summary()
        pathlib.Path(output_path).write_text(content)
        return output_path
