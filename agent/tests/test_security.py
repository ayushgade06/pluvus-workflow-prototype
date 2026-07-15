"""Tests for agent-service auth + rate limiting (FIX-12).

Two layers:
  * Unit tests for the rate limiter and key extraction (pure, no FastAPI).
  * Integration tests via FastAPI TestClient asserting 401 (no/bad key),
    200 (good key / auth disabled), and 429 (over the rate limit).

The protected routes' handler bodies call the LLM, but auth + rate-limit run as
dependencies BEFORE the handler, so 401/429 cases never reach the model and need
no Ollama/langgraph. The 200 cases monkeypatch the underlying engine function so
they don't need a model either.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import security
from app.routes import classify as classify_mod
from app.routes import negotiate as negotiate_mod


# ---------------------------------------------------------------------------
# Unit: key extraction
# ---------------------------------------------------------------------------


def test_extract_bearer_key():
    assert security._extract_presented_key("Bearer abc123", None) == "abc123"


def test_extract_x_api_key():
    assert security._extract_presented_key(None, "abc123") == "abc123"


def test_extract_prefers_bearer_over_x_api_key():
    assert security._extract_presented_key("Bearer fromauth", "fromheader") == "fromauth"


def test_extract_none_when_absent():
    assert security._extract_presented_key(None, None) is None


def test_extract_ignores_non_bearer_scheme():
    assert security._extract_presented_key("Basic abc123", None) is None


# ---------------------------------------------------------------------------
# Unit: fixed-window rate limiter
# ---------------------------------------------------------------------------


def test_limiter_allows_up_to_limit_then_blocks():
    clock = {"t": 0.0}
    limiter = security._FixedWindowLimiter(time_func=lambda: clock["t"])
    for _ in range(3):
        allowed, _ = limiter.check("k", limit=3, window=60.0)
        assert allowed
    allowed, retry_after = limiter.check("k", limit=3, window=60.0)
    assert not allowed
    assert retry_after == pytest.approx(60.0)


def test_limiter_resets_after_window():
    clock = {"t": 0.0}
    limiter = security._FixedWindowLimiter(time_func=lambda: clock["t"])
    limiter.check("k", limit=1, window=10.0)
    blocked, _ = limiter.check("k", limit=1, window=10.0)
    assert not blocked
    clock["t"] = 10.0  # window elapsed
    allowed, _ = limiter.check("k", limit=1, window=10.0)
    assert allowed


def test_limiter_disabled_when_limit_zero():
    limiter = security._FixedWindowLimiter()
    for _ in range(1000):
        allowed, _ = limiter.check("k", limit=0, window=60.0)
        assert allowed


def test_limiter_keys_are_independent():
    clock = {"t": 0.0}
    limiter = security._FixedWindowLimiter(time_func=lambda: clock["t"])
    limiter.check("a", limit=1, window=60.0)
    blocked_a, _ = limiter.check("a", limit=1, window=60.0)
    allowed_b, _ = limiter.check("b", limit=1, window=60.0)
    assert not blocked_a
    assert allowed_b


# ---------------------------------------------------------------------------
# Integration: build an app with both routers and exercise the dependencies
# ---------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    # Stub the engine functions so the 200 path never needs a model.
    monkeypatch.setattr(
        classify_mod,
        "_langgraph_classify",
        lambda message: classify_mod.ClassifyResponse(
            intent="POSITIVE", confidence=0.95, reasoning="stub"
        ),
    )
    monkeypatch.setattr(
        negotiate_mod,
        "_langgraph_negotiate",
        lambda req: negotiate_mod.NegotiateResponse(action="COUNTER", reasoning="stub"),
    )
    security.reset_rate_limiter()
    app = FastAPI()
    app.include_router(classify_mod.router)
    app.include_router(negotiate_mod.router)
    return TestClient(app)


def test_auth_disabled_allows_request(client, monkeypatch):
    monkeypatch.delenv(security.ENV_API_KEY, raising=False)
    r = client.post("/classify", json={"message": "hi"})
    assert r.status_code == 200
    assert r.json()["intent"] == "POSITIVE"


def test_auth_enabled_rejects_missing_key(client, monkeypatch):
    monkeypatch.setenv(security.ENV_API_KEY, "s3cret")
    r = client.post("/classify", json={"message": "hi"})
    assert r.status_code == 401


def test_auth_enabled_rejects_wrong_key(client, monkeypatch):
    monkeypatch.setenv(security.ENV_API_KEY, "s3cret")
    r = client.post("/classify", json={"message": "hi"}, headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_auth_enabled_accepts_bearer_key(client, monkeypatch):
    monkeypatch.setenv(security.ENV_API_KEY, "s3cret")
    r = client.post("/classify", json={"message": "hi"}, headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200


def test_auth_enabled_accepts_x_api_key(client, monkeypatch):
    monkeypatch.setenv(security.ENV_API_KEY, "s3cret")
    r = client.post("/negotiate", json={
        "creatorReply": "ok", "currentOffer": {}, "round": 0, "maxRounds": 3,
        "campaignConstraints": {"termFloor": {}, "termCeiling": {}},
    }, headers={"X-API-Key": "s3cret"})
    assert r.status_code == 200


def test_rate_limit_returns_429_over_threshold(client, monkeypatch):
    monkeypatch.delenv(security.ENV_API_KEY, raising=False)
    monkeypatch.setenv(security.ENV_RATE_LIMIT, "2")
    monkeypatch.setenv(security.ENV_RATE_WINDOW, "60")
    # First two allowed, third blocked (same client/route bucket).
    assert client.post("/classify", json={"message": "1"}).status_code == 200
    assert client.post("/classify", json={"message": "2"}).status_code == 200
    r = client.post("/classify", json={"message": "3"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_rate_limit_is_per_route(client, monkeypatch):
    monkeypatch.delenv(security.ENV_API_KEY, raising=False)
    monkeypatch.setenv(security.ENV_RATE_LIMIT, "1")
    monkeypatch.setenv(security.ENV_RATE_WINDOW, "60")
    # Exhaust /classify; /negotiate has its own bucket and is still allowed.
    assert client.post("/classify", json={"message": "1"}).status_code == 200
    assert client.post("/classify", json={"message": "2"}).status_code == 429
    neg_body = {
        "creatorReply": "ok", "currentOffer": {}, "round": 0, "maxRounds": 3,
        "campaignConstraints": {"termFloor": {}, "termCeiling": {}},
    }
    assert client.post("/negotiate", json=neg_body).status_code == 200


def test_health_route_is_unprotected():
    # /health must never require auth (liveness probe).
    import app.main as main_mod
    importlib.reload(main_mod)
    c = TestClient(main_mod.app)
    assert c.get("/health").status_code == 200


# ---------------------------------------------------------------------------
# W-9(b): rate-limit identity must NOT trust an unvalidated key when auth is off
# ---------------------------------------------------------------------------


def test_rate_limit_ignores_presented_key_when_auth_disabled(client, monkeypatch):
    # Auth OFF. A caller rotating a fresh random key per request must NOT get a
    # fresh bucket each time — otherwise the limit is trivially bypassable. With
    # the fix, identity falls back to the peer IP, so the bucket is shared.
    monkeypatch.delenv(security.ENV_API_KEY, raising=False)
    monkeypatch.setenv(security.ENV_RATE_LIMIT, "2")
    monkeypatch.setenv(security.ENV_RATE_WINDOW, "60")
    assert (
        client.post("/classify", json={"message": "1"}, headers={"X-API-Key": "rot-1"}).status_code
        == 200
    )
    assert (
        client.post("/classify", json={"message": "2"}, headers={"X-API-Key": "rot-2"}).status_code
        == 200
    )
    # Third with yet another new key is still blocked — key rotation didn't help.
    r = client.post("/classify", json={"message": "3"}, headers={"X-API-Key": "rot-3"})
    assert r.status_code == 429


def test_rate_limit_uses_validated_key_when_auth_enabled(client, monkeypatch):
    # Auth ON. Now the presented key IS validated, so it's a legit per-client
    # bucket: two different (valid) callers would not share a limit. Here we use
    # the one configured key, so its bucket fills and blocks as normal.
    monkeypatch.setenv(security.ENV_API_KEY, "s3cret")
    monkeypatch.setenv(security.ENV_RATE_LIMIT, "1")
    monkeypatch.setenv(security.ENV_RATE_WINDOW, "60")
    hdr = {"X-API-Key": "s3cret"}
    assert client.post("/classify", json={"message": "1"}, headers=hdr).status_code == 200
    assert client.post("/classify", json={"message": "2"}, headers=hdr).status_code == 429


# ---------------------------------------------------------------------------
# W-9: fail CLOSED in a deployed environment when no key is configured
# ---------------------------------------------------------------------------


def test_deployed_env_without_key_fails_closed(client, monkeypatch):
    monkeypatch.delenv(security.ENV_API_KEY, raising=False)
    monkeypatch.setenv(security.ENV_APP_ENV, "production")
    r = client.post("/classify", json={"message": "hi"})
    assert r.status_code == 503  # refuses to serve unauthenticated in prod


def test_dev_env_without_key_still_open(client, monkeypatch):
    # AGENT_ENV unset (dev) keeps the no-op-when-unset behavior for offline work.
    monkeypatch.delenv(security.ENV_API_KEY, raising=False)
    monkeypatch.delenv(security.ENV_APP_ENV, raising=False)
    r = client.post("/classify", json={"message": "hi"})
    assert r.status_code == 200


def test_deployed_env_with_key_works_normally(client, monkeypatch):
    monkeypatch.setenv(security.ENV_APP_ENV, "production")
    monkeypatch.setenv(security.ENV_API_KEY, "s3cret")
    ok = client.post("/classify", json={"message": "hi"}, headers={"X-API-Key": "s3cret"})
    assert ok.status_code == 200
    bad = client.post("/classify", json={"message": "hi"})
    assert bad.status_code == 401  # missing key → 401 (auth configured), not 503


# ---------------------------------------------------------------------------
# W-9(c): /metrics is now behind the API key
# ---------------------------------------------------------------------------


def test_metrics_requires_key_when_configured(monkeypatch):
    monkeypatch.setenv(security.ENV_API_KEY, "s3cret")
    import app.main as main_mod
    importlib.reload(main_mod)
    c = TestClient(main_mod.app)
    assert c.get("/metrics").status_code == 401
    assert c.get("/metrics", headers={"X-API-Key": "s3cret"}).status_code == 200


def test_metrics_open_when_auth_disabled(monkeypatch):
    monkeypatch.delenv(security.ENV_API_KEY, raising=False)
    monkeypatch.delenv(security.ENV_APP_ENV, raising=False)
    import app.main as main_mod
    importlib.reload(main_mod)
    c = TestClient(main_mod.app)
    assert c.get("/metrics").status_code == 200
