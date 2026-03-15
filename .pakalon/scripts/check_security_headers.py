#!/usr/bin/env python3
"""Minimal security header audit for the local Pakalon target."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

TARGET_URL = os.getenv("SECURITY_TARGET_URL", "http://host.docker.internal:3000")
TIMEOUT_SECONDS = float(os.getenv("SECURITY_TARGET_TIMEOUT", "10"))
OUTPUT_PATH = Path("/src/.pakalon/security-headers-results.json")

RECOMMENDED_HEADERS = {
    "content-security-policy": "Mitigates XSS by restricting resource loading.",
    "strict-transport-security": "Enforces HTTPS for future requests.",
    "x-content-type-options": "Prevents MIME sniffing.",
    "x-frame-options": "Helps prevent clickjacking.",
    "referrer-policy": "Controls referrer leakage.",
    "permissions-policy": "Restricts access to browser features.",
}


def write_report(report: dict) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")


def main() -> int:
    report: dict[str, object] = {
        "target_url": TARGET_URL,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "timeout_seconds": TIMEOUT_SECONDS,
        "status": "unknown",
        "missing_headers": [],
        "present_headers": {},
        "warnings": [],
    }

    try:
        response = requests.get(TARGET_URL, timeout=TIMEOUT_SECONDS, allow_redirects=True)
    except Exception as exc:  # pragma: no cover - defensive runtime path
        report["status"] = "unreachable"
        report["error"] = str(exc)
        write_report(report)
        print(f"[security-headers] Could not reach {TARGET_URL}: {exc}", file=sys.stderr)
        return 1

    lowered_headers = {key.lower(): value for key, value in response.headers.items()}
    missing_headers = [header for header in RECOMMENDED_HEADERS if header not in lowered_headers]

    report.update(
        {
            "status": "ok",
            "final_url": response.url,
            "status_code": response.status_code,
            "missing_headers": missing_headers,
            "present_headers": {header: lowered_headers.get(header) for header in RECOMMENDED_HEADERS if header in lowered_headers},
        }
    )

    if response.url.startswith("http://"):
        report["warnings"].append(
            "Target responded over HTTP. HSTS is only effective when the app is served over HTTPS."
        )

    if missing_headers:
        print(f"[security-headers] Missing {len(missing_headers)} recommended headers for {response.url}")
    else:
        print(f"[security-headers] All recommended headers detected for {response.url}")

    write_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
