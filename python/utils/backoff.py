"""
backoff.py — Exponential backoff utilities for Python agent calls.
T0-4: Consistent retry logic for all outbound HTTP / LLM / external API calls.

Usage:
    from utils.backoff import with_retry, backoff_retry, RetryConfig

    # Simple decorator
    @backoff_retry(max_attempts=5, base_delay=1.0)
    async def call_openai(prompt: str) -> str:
        ...

    # Functional
    result = await with_retry(my_async_fn, args=(arg1,), config=RetryConfig(max_attempts=3))
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, Callable, Optional, Sequence, Type, TypeVar

import httpx

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Default HTTP status codes that should trigger a retry
DEFAULT_RETRY_STATUS_CODES: frozenset[int] = frozenset({
    408,  # Request Timeout
    429,  # Too Many Requests
    500,  # Internal Server Error
    502,  # Bad Gateway
    503,  # Service Unavailable
    504,  # Gateway Timeout
})

# Exception types that should trigger a retry (network-level failures)
DEFAULT_RETRY_EXCEPTIONS: tuple[type[Exception], ...] = (
    httpx.ConnectError,
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.RemoteProtocolError,
    ConnectionResetError,
    ConnectionRefusedError,
    TimeoutError,
)


@dataclass
class RetryConfig:
    """Configuration for retry behaviour."""

    max_attempts: int = 5
    """Maximum total attempts (1 = no retry)."""

    base_delay: float = 1.0
    """Base sleep in seconds before first retry."""

    max_delay: float = 60.0
    """Maximum sleep cap per attempt."""

    backoff_factor: float = 2.0
    """Multiplier per retry (exponential: base * factor^attempt)."""

    jitter: bool = True
    """Add ±25 % random jitter to prevent thundering herd."""

    retry_status_codes: frozenset[int] = field(default_factory=lambda: DEFAULT_RETRY_STATUS_CODES)
    """HTTP status codes that trigger a retry."""

    retry_exceptions: tuple[type[Exception], ...] = field(default_factory=lambda: DEFAULT_RETRY_EXCEPTIONS)
    """Exception types that trigger a retry."""

    on_retry: Optional[Callable[[int, Exception, float], None]] = None
    """Optional callback called before each retry: (attempt, exc, sleep_secs)."""


def _compute_delay(attempt: int, config: RetryConfig) -> float:
    """Return the sleep duration for a given attempt index (0-based)."""
    delay = min(config.base_delay * (config.backoff_factor ** attempt), config.max_delay)
    if config.jitter:
        delay *= random.uniform(0.75, 1.25)
    return delay


def _extract_retry_after(exc: Exception) -> Optional[float]:
    """
    Try to extract Retry-After seconds from an httpx HTTP status error.
    Returns None if not present or not parseable.
    """
    if not isinstance(exc, httpx.HTTPStatusError):
        return None
    header = exc.response.headers.get("retry-after") or exc.response.headers.get("x-ratelimit-reset-after")
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        return None


def _should_retry(exc: Exception, config: RetryConfig) -> bool:
    """Determine whether an exception warrants a retry."""
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in config.retry_status_codes
    return isinstance(exc, config.retry_exceptions)


# ─────────────────────────────────────────────────────────────────────────────
# Async retry
# ─────────────────────────────────────────────────────────────────────────────

async def with_retry(
    fn: Callable[..., Any],
    args: tuple[Any, ...] = (),
    kwargs: dict[str, Any] | None = None,
    config: RetryConfig | None = None,
) -> Any:
    """
    Call *fn* with *args* and *kwargs*, retrying on transient failures.

    Parameters
    ----------
    fn      : Async (or sync) callable.
    args    : Positional arguments to pass.
    kwargs  : Keyword arguments to pass.
    config  : RetryConfig (defaults to RetryConfig() if not given).

    Returns
    -------
    Whatever *fn* returns on success.

    Raises
    ------
    The last exception if all attempts are exhausted.
    """
    cfg = config or RetryConfig()
    kwargs = kwargs or {}
    last_exc: Exception = RuntimeError("No attempts made")

    for attempt in range(cfg.max_attempts):
        try:
            if asyncio.iscoroutinefunction(fn):
                return await fn(*args, **kwargs)
            return fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc

            if attempt >= cfg.max_attempts - 1:
                break  # Last attempt — don't sleep, just re-raise below

            if not _should_retry(exc, cfg):
                raise  # Non-retryable — re-raise immediately

            # Respect Retry-After header if present
            delay = _extract_retry_after(exc) or _compute_delay(attempt, cfg)

            if cfg.on_retry:
                cfg.on_retry(attempt + 1, exc, delay)

            logger.warning(
                "Attempt %d/%d failed (%s: %s). Retrying in %.1fs…",
                attempt + 1,
                cfg.max_attempts,
                type(exc).__name__,
                str(exc)[:120],
                delay,
            )
            await asyncio.sleep(delay)

    raise last_exc


# ─────────────────────────────────────────────────────────────────────────────
# Synchronous variant (for non-async code paths)
# ─────────────────────────────────────────────────────────────────────────────

def with_retry_sync(
    fn: Callable[..., T],
    args: tuple[Any, ...] = (),
    kwargs: dict[str, Any] | None = None,
    config: RetryConfig | None = None,
) -> T:
    """Synchronous version of *with_retry*."""
    cfg = config or RetryConfig()
    kwargs = kwargs or {}
    last_exc: Exception = RuntimeError("No attempts made")

    for attempt in range(cfg.max_attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc

            if attempt >= cfg.max_attempts - 1:
                break

            if not _should_retry(exc, cfg):
                raise

            delay = _extract_retry_after(exc) or _compute_delay(attempt, cfg)

            if cfg.on_retry:
                cfg.on_retry(attempt + 1, exc, delay)

            logger.warning(
                "Attempt %d/%d failed (%s). Retrying in %.1fs…",
                attempt + 1, cfg.max_attempts, type(exc).__name__, delay,
            )
            time.sleep(delay)

    raise last_exc


# ─────────────────────────────────────────────────────────────────────────────
# Decorator factories
# ─────────────────────────────────────────────────────────────────────────────

def backoff_retry(
    max_attempts: int = 5,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    backoff_factor: float = 2.0,
    jitter: bool = True,
    retry_status_codes: Sequence[int] | None = None,
    retry_exceptions: tuple[type[Exception], ...] | None = None,
) -> Callable:
    """
    Decorator that applies exponential backoff to async functions.

    Example::

        @backoff_retry(max_attempts=4, base_delay=2.0)
        async def call_llm(prompt: str) -> str:
            ...
    """
    config = RetryConfig(
        max_attempts=max_attempts,
        base_delay=base_delay,
        max_delay=max_delay,
        backoff_factor=backoff_factor,
        jitter=jitter,
        retry_status_codes=frozenset(retry_status_codes) if retry_status_codes else DEFAULT_RETRY_STATUS_CODES,
        retry_exceptions=retry_exceptions or DEFAULT_RETRY_EXCEPTIONS,
    )

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            return await with_retry(fn, args=args, kwargs=kwargs, config=config)

        return wrapper

    return decorator


def backoff_retry_sync(
    max_attempts: int = 5,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    backoff_factor: float = 2.0,
) -> Callable:
    """Synchronous version of *backoff_retry*."""
    config = RetryConfig(
        max_attempts=max_attempts,
        base_delay=base_delay,
        max_delay=max_delay,
        backoff_factor=backoff_factor,
    )

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return with_retry_sync(fn, args=args, kwargs=kwargs, config=config)

        return wrapper

    return decorator
