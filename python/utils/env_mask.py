"""
env_mask.py — Block .env files and mask secrets in Python agent context.
T1-8: Prevent LLM from seeing credentials, API keys, or secrets.

Usage::

    from utils.env_mask import (
        is_blocked_file,
        mask_secrets,
        safe_read_for_context,
        filter_context_files,
    )

    # Check before reading
    if is_blocked_file("/project/.env"):
        raise ValueError("Blocked: .env files must not be sent to LLM")

    # Mask a string that might contain secrets
    safe_content = mask_secrets(raw_content)

    # Read file safely (blocks .env, masks secrets)
    content = safe_read_for_context("/project/config.py")
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Files that MUST NEVER be sent to an LLM
# ─────────────────────────────────────────────────────────────────────────────

BLOCKED_FILENAMES: frozenset[str] = frozenset({
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    ".env.staging",
    ".envrc",
    "secrets.yaml",
    "secrets.yml",
    "credentials.json",
    "service-account.json",
    "serviceaccount.json",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".aws/credentials",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "*.pem",          # matched via pattern
    "*.key",          # matched via pattern
    "*.p12",          # matched via pattern
    "*.pfx",          # matched via pattern
})

BLOCKED_PATTERNS: tuple[re.Pattern, ...] = (
    re.compile(r"^\.env(\.[a-z]+)*$"),          # .env, .env.local, etc.
    re.compile(r"^.*\.(pem|key|p12|pfx|crt)$"), # TLS/SSH key files
    re.compile(r"secrets?\.(ya?ml|json|toml)$", re.I),
    re.compile(r"credentials?\.(json|ya?ml|ini)$", re.I),
    re.compile(r"serviceaccount.*\.json$", re.I),
    re.compile(r"^\.aws/credentials$"),
)

# ─────────────────────────────────────────────────────────────────────────────
# Secret value patterns (regexes that match the VALUE region of a line)
# ─────────────────────────────────────────────────────────────────────────────

SECRET_PATTERNS: tuple[tuple[str, re.Pattern], ...] = (
    ("OpenAI key",      re.compile(r'sk-[A-Za-z0-9\-_]{20,}')),
    ("GitHub PAT",      re.compile(r'gh[pousr]_[A-Za-z0-9]{36,}')),
    ("AWS key",         re.compile(r'AKIA[0-9A-Z]{16}')),
    ("AWS secret",      re.compile(r'(?i)aws.{0,10}secret.{0,10}[=:]\s*["\']?[A-Za-z0-9/+]{40}["\']?')),
    ("Bearer token",    re.compile(r'(?i)bearer\s+[A-Za-z0-9\-._~+/]+=*')),
    ("Basic auth",      re.compile(r'(?i)basic\s+[A-Za-z0-9+/]+=*')),
    ("DB URI",          re.compile(r'(?i)(postgres|mysql|mongodb|redis|amqp)://[^\s"\']+')),
    ("Generic secret",  re.compile(r'(?i)(password|passwd|secret|api[_-]?key|auth[_-]?token|private[_-]?key)\s*[=:]\s*["\']?[^\s"\']{8,}["\']?')),
    ("Stripe key",      re.compile(r'sk_(live|test)_[A-Za-z0-9]{24,}')),
    ("SendGrid key",    re.compile(r'SG\.[A-Za-z0-9\-_]{22,}\.[A-Za-z0-9\-_]{43,}')),
    ("Twilio SID",      re.compile(r'AC[0-9a-f]{32}')),
    ("JWT",             re.compile(r'eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+')),
)

MASK_REPLACEMENT = "[REDACTED]"


def is_blocked_file(path: str | Path) -> bool:
    """
    Return True if the file at *path* should NEVER be read into LLM context.
    Checks by filename, relative path suffix, and extension patterns.
    """
    p = Path(path)
    name = p.name
    # Exact name match
    if name in BLOCKED_FILENAMES:
        return True
    # Regex pattern match against the full name
    for pat in BLOCKED_PATTERNS:
        if pat.search(name) or pat.search(str(p)):
            return True
    return False


def mask_secrets(content: str) -> str:
    """
    Replace any secret values found in *content* with [REDACTED].
    Logs a warning for each match found.
    """
    import logging
    log = logging.getLogger(__name__)

    result = content
    for label, pattern in SECRET_PATTERNS:
        matches = pattern.findall(result)
        if matches:
            count = len(matches)
            log.warning("Masking %d %s occurrence(s) in content", count, label)
            result = pattern.sub(MASK_REPLACEMENT, result)

    return result


def safe_read_for_context(path: str | Path, max_bytes: int = 100_000) -> Optional[str]:
    """
    Read a file for inclusion in LLM context with the following safety checks:
    - Blocked files return None.
    - Secret patterns are replaced with [REDACTED].
    - Content is truncated to *max_bytes*.

    Returns None if the file is blocked or cannot be read.
    """
    p = Path(path)
    if is_blocked_file(p):
        return None  # Silently block

    try:
        raw = p.read_bytes()[:max_bytes].decode("utf-8", errors="replace")
    except OSError:
        return None

    return mask_secrets(raw)


def filter_context_files(paths: list[str | Path]) -> list[str]:
    """
    Filter a list of file paths, removing any that are blocked.
    Returns the allowed paths as strings.
    """
    return [str(p) for p in paths if not is_blocked_file(p)]


def find_env_files(directory: str | Path) -> list[Path]:
    """
    Recursively find all .env-style files under *directory*.
    Useful for auditing / reporting — these files should never be read by the agent.
    """
    root = Path(directory)
    found: list[Path] = []
    try:
        for candidate in root.rglob("*"):
            if candidate.is_file() and is_blocked_file(candidate):
                found.append(candidate)
    except PermissionError:
        pass
    return found


# ─────────────────────────────────────────────────────────────────────────────
# Convenience: sanitize an entire dict (e.g. os.environ snapshot)
# ─────────────────────────────────────────────────────────────────────────────

_ENV_KEY_BLOCKLIST: re.Pattern = re.compile(
    r"(?i)(password|secret|key|token|credential|auth|private|cert|pem|jwt|api_?key)"
)


def sanitize_env_dict(env: dict[str, str]) -> dict[str, str]:
    """
    Return a copy of *env* with sensitive-looking values replaced by [REDACTED].
    Useful for logging os.environ snapshots safely.
    """
    return {
        k: (MASK_REPLACEMENT if _ENV_KEY_BLOCKLIST.search(k) else v)
        for k, v in env.items()
    }
