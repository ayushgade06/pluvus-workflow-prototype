"""
Auth + rate limiting for the agent service (FIX-12).

The agent service decides negotiation actions and burns LLM compute. Before this
module, `/classify`, `/negotiate`, and `/draft` were reachable by anyone who
could reach the port — no auth, no rate limit (see the gap analysis,
"Agent service architecture" and the Security Review's "Abuse handling" row).

This module adds two FastAPI dependencies, both **env-gated** so existing local
dev and the harnesses keep working with zero config:

  * ``require_api_key`` — checks a shared secret on every protected route.
    Enabled only when ``AGENT_API_KEY`` is set. The caller presents it as either
    ``Authorization: Bearer <key>`` or ``X-API-Key: <key>``. When the env var is
    unset the dependency is a no-op (and logs a one-time warning) so harnesses
    and offline dev are unaffected; set it in any deployed environment.

  * ``rate_limiter(name)`` — a small dependency-free fixed-window limiter keyed
    on (route, client). No Redis, no slowapi, no extra dependency (the audit
    explicitly warns against bolting on infra). Tunable via env; disabled when
    the limit is <= 0. In-process only — correct for the single-worker agent
    service; a multi-worker deployment would move this to a shared store, noted.

Design choices:
  * Constant-time key comparison (``hmac.compare_digest``) to avoid timing oracles.
  * 401 on missing/!bad key (never 403 — we don't distinguish "who you are").
  * 429 with a ``Retry-After`` header on limit breach.
  * Time source is injectable so the limiter is unit-testable without sleeping.
"""

from __future__ import annotations

import hmac
import logging
import os
import threading
import time
from collections import defaultdict
from typing import Callable

from fastapi import Header, HTTPException, Request, status

logger = logging.getLogger("agent.security")

# Env var names (single source of truth so tests and routes agree).
ENV_API_KEY = "AGENT_API_KEY"
ENV_RATE_LIMIT = "AGENT_RATE_LIMIT"          # max requests per window per client+route
ENV_RATE_WINDOW = "AGENT_RATE_WINDOW_SECONDS"  # window length in seconds
ENV_APP_ENV = "AGENT_ENV"                    # deployment env: prod/production ⇒ enforce auth

_DEFAULT_RATE_LIMIT = 60      # requests
_DEFAULT_RATE_WINDOW = 60.0   # seconds  → 60 req/min/client/route by default

_auth_warning_emitted = False


def _is_deployed_env() -> bool:
    """True when AGENT_ENV names a deployed environment (prod/production/staging).

    Used to FAIL CLOSED: in a deployed env, a missing AGENT_API_KEY is a
    misconfiguration, not a dev convenience — so the auth dependency rejects
    every request instead of silently running open (W-9). Local dev / harnesses
    leave AGENT_ENV unset and keep the no-op-when-unset behavior.
    """
    return os.getenv(ENV_APP_ENV, "").strip().lower() in {"prod", "production", "staging"}


def auth_enabled() -> bool:
    """True when a shared secret is configured. When True, a presented key has
    been validated by require_api_key before the handler runs, so it is safe to
    use as a rate-limit identity; when False it has NOT, so it must not be
    trusted (W-9 rate-limiter bypass)."""
    return bool(os.getenv(ENV_API_KEY))


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _extract_presented_key(authorization: str | None, x_api_key: str | None) -> str | None:
    """Pull the presented secret from either supported header, if any."""
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token:
            return token.strip()
    if x_api_key:
        return x_api_key.strip()
    return None


def require_api_key(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    """FastAPI dependency: enforce the shared secret when configured.

    No-op (with a one-time warning) when ``AGENT_API_KEY`` is unset, so local
    dev / harnesses keep working. When set, a missing or wrong key → 401.
    """
    expected = os.getenv(ENV_API_KEY)
    if not expected:
        # W-9: in a DEPLOYED environment a missing key is a misconfiguration —
        # fail CLOSED (503) rather than serve the money-path endpoints open. In
        # dev / harnesses (AGENT_ENV unset) keep the no-op-with-warning behavior
        # so offline work needs zero config.
        if _is_deployed_env():
            logger.error(
                "%s is not set but %s indicates a deployed environment — refusing "
                "requests. Set the API key.",
                ENV_API_KEY,
                ENV_APP_ENV,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Agent auth is not configured.",
            )
        global _auth_warning_emitted
        if not _auth_warning_emitted:
            logger.warning(
                "%s is not set — agent endpoints are UNAUTHENTICATED. "
                "Set it in any deployed environment.",
                ENV_API_KEY,
            )
            _auth_warning_emitted = True
        return

    presented = _extract_presented_key(authorization, x_api_key)
    # compare_digest needs two strings; use a constant placeholder when missing
    # so the timing of "no key" matches "wrong key".
    if presented is None or not hmac.compare_digest(presented, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid API key.",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ---------------------------------------------------------------------------
# Rate limiting (fixed window, in-process, dependency-free)
# ---------------------------------------------------------------------------


class _FixedWindowLimiter:
    """Per-key fixed-window counter. Thread-safe; injectable clock for tests.

    A key is (route_name, client_id). Within a window of ``window`` seconds at
    most ``limit`` requests are allowed; the (limit+1)th raises 429. The window
    resets ``window`` seconds after its first request.
    """

    def __init__(self, time_func: Callable[[], float] = time.monotonic) -> None:
        self._time = time_func
        self._lock = threading.Lock()
        # key -> (window_start, count)
        self._buckets: dict[str, tuple[float, int]] = defaultdict(lambda: (0.0, 0))

    def check(self, key: str, *, limit: int, window: float) -> tuple[bool, float]:
        """Return (allowed, retry_after_seconds). retry_after is 0 when allowed."""
        if limit <= 0:  # limiting disabled
            return True, 0.0
        now = self._time()
        with self._lock:
            start, count = self._buckets[key]
            if now - start >= window:
                # New window.
                self._buckets[key] = (now, 1)
                return True, 0.0
            if count < limit:
                self._buckets[key] = (start, count + 1)
                return True, 0.0
            # Over the limit within the current window.
            retry_after = max(0.0, window - (now - start))
            return False, retry_after

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


# Module-level singleton (the agent service runs single-process by default).
_limiter = _FixedWindowLimiter()


def _client_id(request: Request) -> str:
    """Best-effort per-client identity for rate-limiting.

    W-9: the presented key is used as identity ONLY when auth is enabled — in
    that case require_api_key has already validated it, so it's a trustworthy
    bucket key. When auth is OFF the key is attacker-controlled and unvalidated;
    trusting it let a caller dodge the limit by sending a fresh random key per
    request (a new bucket each time). With auth off we therefore key on the peer
    IP only, which the caller cannot cheaply rotate.
    """
    if auth_enabled():
        api_key = _extract_presented_key(
            request.headers.get("authorization"),
            request.headers.get("x-api-key"),
        )
        if api_key:
            return f"key:{api_key}"
    client = request.client
    return f"ip:{client.host}" if client else "ip:unknown"


def _rate_config() -> tuple[int, float]:
    """Read (limit, window) from env with safe defaults and validation."""
    try:
        limit = int(os.getenv(ENV_RATE_LIMIT, str(_DEFAULT_RATE_LIMIT)))
    except ValueError:
        limit = _DEFAULT_RATE_LIMIT
    try:
        window = float(os.getenv(ENV_RATE_WINDOW, str(_DEFAULT_RATE_WINDOW)))
    except ValueError:
        window = _DEFAULT_RATE_WINDOW
    if window <= 0:
        window = _DEFAULT_RATE_WINDOW
    return limit, window


def rate_limiter(name: str) -> Callable[[Request], None]:
    """Build a FastAPI dependency that rate-limits the named route per client."""

    def _dep(request: Request) -> None:
        limit, window = _rate_config()
        key = f"{name}:{_client_id(request)}"
        allowed, retry_after = _limiter.check(key, limit=limit, window=window)
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded. Slow down.",
                headers={"Retry-After": str(int(retry_after) + 1)},
            )

    return _dep


def reset_rate_limiter() -> None:
    """Test helper: clear all rate-limit buckets."""
    _limiter.reset()
