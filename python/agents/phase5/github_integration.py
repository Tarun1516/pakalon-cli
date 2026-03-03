"""
github_integration.py — GitHub issue/PR creation from agent phase outputs.
T1-2 / T0-3: Automatically create GitHub issues for findings from SAST/DAST,
              open PRs for generated fixes, and link findings to issues.

Requires: GITHUB_TOKEN env var + `gh` CLI (or PyGithub).
Falls back to generating a CLI command string if gh is unavailable.
"""

from __future__ import annotations

import logging
import os
import subprocess
import textwrap
from dataclasses import dataclass, field
from typing import Optional

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

logger = logging.getLogger(__name__)

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")


# T-B18: GitHub REST API helper
def _create_pr_via_api(draft: PRDraft) -> GitHubResult:
    """Create PR via GitHub REST API (not just CLI)."""
    if not HTTPX_AVAILABLE:
        return GitHubResult(ok=False, message="httpx not installed")
    
    if not draft.repo or not GITHUB_TOKEN:
        return GitHubResult(ok=False, message="Missing repo or GITHUB_TOKEN")
    
    owner, repo = draft.repo.split("/", 1)
    api_url = f"https://api.github.com/repos/{owner}/{repo}/pulls"
    
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                api_url,
                headers={
                    "Authorization": f"token {GITHUB_TOKEN}",
                    "Accept": "application/vnd.github.v3+json",
                    "Content-Type": "application/json",
                },
                json={
                    "title": draft.title,
                    "body": draft.body,
                    "head": draft.head,
                    "base": draft.base,
                    "draft": draft.draft,
                },
            )
            if resp.status_code == 201:
                data = resp.json()
                url = data.get("html_url", "")
                number = data.get("number")
                logger.info("Created PR #%s via REST API: %s", number, url)
                return GitHubResult(ok=True, url=url, number=number, message=f"PR #{number} created via REST API")
            else:
                return GitHubResult(ok=False, message=f"GitHub API error: {resp.status_code} - {resp.text[:200]}")
    except Exception as e:
        logger.error("REST API PR creation failed: %s", e)
        return GitHubResult(ok=False, message=str(e))


# ─────────────────────────────────────────────────────────────────────────────
# Data models
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class IssueDraft:
    title: str
    body: str
    labels: list[str] = field(default_factory=list)
    assignees: list[str] = field(default_factory=list)
    milestone: Optional[str] = None
    repo: Optional[str] = None  # "owner/repo" — defaults to current repo


@dataclass
class PRDraft:
    title: str
    body: str
    head: str                   # Source branch
    base: str = "main"          # Target branch
    draft: bool = False
    assignees: list[str] = field(default_factory=list)
    labels: list[str] = field(default_factory=list)
    repo: Optional[str] = None


@dataclass
class GitHubResult:
    ok: bool
    url: Optional[str] = None
    number: Optional[int] = None
    message: str = ""
    command_hint: str = ""      # Shows the gh CLI command if gh is unavailable


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _gh_available() -> bool:
    try:
        subprocess.run(["gh", "--version"], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def _run_gh(*args: str, repo: Optional[str] = None) -> tuple[bool, str, str]:
    """Run a `gh` command. Returns (ok, stdout, stderr)."""
    cmd = ["gh", *args]
    if repo:
        cmd += ["--repo", repo]
    env = {**os.environ, "GITHUB_TOKEN": GITHUB_TOKEN} if GITHUB_TOKEN else os.environ.copy()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=30)
        return result.returncode == 0, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, "", "gh command timed out"
    except FileNotFoundError:
        return False, "", "gh CLI not found"


# ─────────────────────────────────────────────────────────────────────────────
# Issue creation
# ─────────────────────────────────────────────────────────────────────────────

def create_issue(draft: IssueDraft) -> GitHubResult:
    """
    Create a GitHub issue from an IssueDraft.
    Uses `gh issue create` if available, otherwise returns the CLI command.
    """
    cmd_hint_parts = [
        "gh issue create",
        f"--title {_quote(draft.title)}",
        f"--body {_quote(draft.body)}",
    ]
    if draft.labels:
        cmd_hint_parts.append(f"--label {','.join(draft.labels)}")
    if draft.assignees:
        cmd_hint_parts.append(f"--assignee {','.join(draft.assignees)}")
    if draft.repo:
        cmd_hint_parts.append(f"--repo {draft.repo}")

    command_hint = " ".join(cmd_hint_parts)

    if not _gh_available():
        logger.info("gh CLI not available; providing command hint")
        return GitHubResult(ok=False, message="gh CLI not available", command_hint=command_hint)

    args = [
        "issue", "create",
        "--title", draft.title,
        "--body", draft.body,
    ]
    if draft.labels:
        args += ["--label", ",".join(draft.labels)]
    if draft.assignees:
        args += ["--assignee", ",".join(draft.assignees)]

    ok, stdout, stderr = _run_gh(*args, repo=draft.repo)
    if ok:
        url = stdout.strip()
        number = _extract_number_from_url(url)
        logger.info("Created issue #%s: %s", number, url)
        return GitHubResult(ok=True, url=url, number=number, message=f"Issue #{number} created")
    else:
        logger.error("Failed to create issue: %s", stderr)
        return GitHubResult(ok=False, message=f"gh error: {stderr}", command_hint=command_hint)


# ─────────────────────────────────────────────────────────────────────────────
# PR creation
# ─────────────────────────────────────────────────────────────────────────────

def create_pull_request(draft: PRDraft) -> GitHubResult:
    """Create a GitHub Pull Request from a PRDraft."""
    # T-B18: Try REST API first, fall back to gh CLI
    if GITHUB_TOKEN and draft.repo:
        result = _create_pr_via_api(draft)
        if result.ok:
            return result
    
    # Fall back to gh CLI
    cmd_hint_parts = [
    """Create a GitHub Pull Request from a PRDraft."""
    cmd_hint_parts = [
        "gh pr create",
        f"--title {_quote(draft.title)}",
        f"--body {_quote(draft.body)}",
        f"--head {draft.head}",
        f"--base {draft.base}",
    ]
    if draft.draft:
        cmd_hint_parts.append("--draft")
    if draft.repo:
        cmd_hint_parts.append(f"--repo {draft.repo}")

    command_hint = " ".join(cmd_hint_parts)

    if not _gh_available():
        return GitHubResult(ok=False, message="gh CLI not available", command_hint=command_hint)

    args = [
        "pr", "create",
        "--title", draft.title,
        "--body", draft.body,
        "--head", draft.head,
        "--base", draft.base,
    ]
    if draft.draft:
        args.append("--draft")
    if draft.labels:
        args += ["--label", ",".join(draft.labels)]
    if draft.assignees:
        args += ["--assignee", ",".join(draft.assignees)]

    ok, stdout, stderr = _run_gh(*args, repo=draft.repo)
    if ok:
        url = stdout.strip()
        number = _extract_number_from_url(url)
        return GitHubResult(ok=True, url=url, number=number, message=f"PR #{number} created")
    else:
        return GitHubResult(ok=False, message=f"gh error: {stderr}", command_hint=command_hint)


# ─────────────────────────────────────────────────────────────────────────────
# Auto-create issues from security findings (Phase 4 output)
# ─────────────────────────────────────────────────────────────────────────────

def findings_to_issues(
    findings: list[dict],
    severity_threshold: str = "medium",
    repo: Optional[str] = None,
    dry_run: bool = True,
) -> list[GitHubResult]:
    """
    Convert Phase 4 SAST/DAST findings into GitHub issues.

    Parameters
    ----------
    findings          : List of finding dicts (from phase4/sast.py or dast.py).
    severity_threshold: Minimum severity to create an issue for ("low"/"medium"/"high"/"critical").
    repo              : "owner/repo" string; None = current repo.
    dry_run           : If True, return GitHubResult with command_hint but don't actually create.

    Returns list of GitHubResult (one per finding above threshold).
    """
    sev_order = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    threshold_val = sev_order.get(severity_threshold.lower(), 1)

    results: list[GitHubResult] = []

    for finding in findings:
        severity = finding.get("severity", "medium").lower()
        if sev_order.get(severity, 0) < threshold_val:
            continue

        title = f"[{severity.upper()}] {finding.get('rule_id', 'Security')} — {finding.get('message', 'finding')[:60]}"

        body = textwrap.dedent(f"""
        ## Security Finding

        **Severity**: {severity.upper()}
        **Rule**: `{finding.get('rule_id', 'unknown')}`
        **File**: `{finding.get('file', 'unknown')}:{finding.get('line', '?')}`

        ### Description
        {finding.get('message', 'No description available.')}

        ### Recommendation
        {finding.get('fix_hint', 'Review and remediate according to security best practices.')}

        ---
        *Auto-generated by Pakalon Phase 4 Security Scanner*
        """).strip()

        labels = ["security", f"severity:{severity}"]
        draft = IssueDraft(title=title, body=body, labels=labels, repo=repo)

        if dry_run:
            # Build command hint only
            cmd = f"gh issue create --title {_quote(title)} --label {','.join(labels)}"
            results.append(GitHubResult(ok=True, message="(dry-run)", command_hint=cmd))
        else:
            results.append(create_issue(draft))

    return results


# ─────────────────────────────────────────────────────────────────────────────
# List open issues / PRs
# ─────────────────────────────────────────────────────────────────────────────

def list_issues(repo: Optional[str] = None, label: Optional[str] = None, limit: int = 20) -> list[dict]:
    """Return a list of open issues as dicts."""
    if not _gh_available():
        return []

    args = ["issue", "list", "--state", "open", "--limit", str(limit), "--json", "number,title,labels,url,createdAt"]
    if label:
        args += ["--label", label]

    ok, stdout, _ = _run_gh(*args, repo=repo)
    if not ok or not stdout:
        return []

    import json
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return []


def list_pull_requests(repo: Optional[str] = None, limit: int = 20) -> list[dict]:
    """Return a list of open PRs as dicts."""
    if not _gh_available():
        return []

    args = ["pr", "list", "--state", "open", "--limit", str(limit), "--json", "number,title,headRefName,url,author,createdAt"]
    ok, stdout, _ = _run_gh(*args, repo=repo)
    if not ok or not stdout:
        return []

    import json
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# Internal utils
# ─────────────────────────────────────────────────────────────────────────────

def _quote(s: str) -> str:
    escaped = s.replace("'", "'\\''")
    return f"'{escaped}'"


def _extract_number_from_url(url: str) -> Optional[int]:
    import re
    m = re.search(r"/(\d+)$", url)
    return int(m.group(1)) if m else None
