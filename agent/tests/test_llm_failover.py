"""Tests for LLM failover + model pinning (FIX-8).

Pure — uses fake chat models / factories so no Ollama/OpenAI SDK or network is
needed. Covers: Ollama model-id pinning (digest), provider-chain resolution
(primary + optional fallback, dedup), and the FailoverChat invoke behavior
(primary success, failover, all-fail).
"""

from __future__ import annotations

import pytest

from app import llm as llm_mod
from app.llm import FailoverChat, _candidate_chain, _ollama_model_id


# ---------------------------------------------------------------------------
# Model pinning
# ---------------------------------------------------------------------------


def test_ollama_model_id_default(monkeypatch):
    monkeypatch.delenv("OLLAMA_MODEL", raising=False)
    monkeypatch.delenv("OLLAMA_MODEL_DIGEST", raising=False)
    assert _ollama_model_id() == "qwen2.5:7b"


def test_ollama_model_id_custom_tag(monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "llama3.1:8b")
    monkeypatch.delenv("OLLAMA_MODEL_DIGEST", raising=False)
    assert _ollama_model_id() == "llama3.1:8b"


def test_ollama_model_id_pins_digest(monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "qwen2.5:7b")
    monkeypatch.setenv("OLLAMA_MODEL_DIGEST", "sha256:abc123")
    assert _ollama_model_id() == "qwen2.5:7b@sha256:abc123"


def test_ollama_model_id_adds_sha256_prefix(monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "qwen2.5:7b")
    monkeypatch.setenv("OLLAMA_MODEL_DIGEST", "abc123")  # no prefix
    assert _ollama_model_id() == "qwen2.5:7b@sha256:abc123"


# ---------------------------------------------------------------------------
# Provider chain
# ---------------------------------------------------------------------------


def test_chain_primary_only(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.delenv("LLM_FALLBACK_PROVIDER", raising=False)
    assert _candidate_chain() == ["ollama"]


def test_chain_with_fallback(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "openai")
    assert _candidate_chain() == ["ollama", "openai"]


def test_chain_dedups_identical_fallback(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "ollama")
    assert _candidate_chain() == ["ollama"]


def test_get_llm_unknown_provider_raises(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "nope")
    monkeypatch.delenv("LLM_FALLBACK_PROVIDER", raising=False)
    with pytest.raises(RuntimeError, match="Unknown LLM provider"):
        llm_mod.get_llm()


# ---------------------------------------------------------------------------
# FailoverChat
# ---------------------------------------------------------------------------


class _Resp:
    def __init__(self, content):
        self.content = content


class _OkModel:
    def __init__(self, content):
        self._content = content
        self.calls = 0

    def invoke(self, _prompt):
        self.calls += 1
        return _Resp(self._content)


class _FailingModel:
    def __init__(self):
        self.calls = 0

    def invoke(self, _prompt):
        self.calls += 1
        raise RuntimeError("backend down")


def test_failover_uses_primary_when_ok():
    primary = _OkModel("primary-said-this")
    secondary = _OkModel("secondary")
    chat = FailoverChat([("primary", lambda _t: primary), ("secondary", lambda _t: secondary)], 0)
    out = chat.invoke("p")
    assert out.content == "primary-said-this"
    assert primary.calls == 1
    assert secondary.calls == 0  # fallback untouched


def test_failover_falls_over_on_primary_failure():
    primary = _FailingModel()
    secondary = _OkModel("served-by-fallback")
    chat = FailoverChat([("primary", lambda _t: primary), ("secondary", lambda _t: secondary)], 0)
    out = chat.invoke("p")
    assert out.content == "served-by-fallback"
    assert primary.calls == 1
    assert secondary.calls == 1


def test_failover_raises_when_all_fail():
    chat = FailoverChat(
        [("primary", lambda _t: _FailingModel()), ("secondary", lambda _t: _FailingModel())], 0
    )
    with pytest.raises(RuntimeError, match="all LLM candidates failed"):
        chat.invoke("p")


def test_failover_does_not_build_fallback_unless_needed():
    # The fallback factory must not be invoked when the primary succeeds — this
    # is why constructing the wrapper never requires the fallback SDK.
    built = {"secondary": False}

    def secondary_factory(_t):
        built["secondary"] = True
        return _OkModel("x")

    chat = FailoverChat([("primary", lambda _t: _OkModel("ok")), ("secondary", secondary_factory)], 0)
    chat.invoke("p")
    assert built["secondary"] is False


def test_get_llm_no_fallback_returns_direct_model(monkeypatch):
    # With no fallback, get_llm returns the provider's model directly (not a
    # FailoverChat wrapper) — zero overhead, unchanged behavior.
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.delenv("LLM_FALLBACK_PROVIDER", raising=False)
    sentinel = object()
    monkeypatch.setitem(llm_mod._PROVIDERS, "ollama", lambda _t: sentinel)
    assert llm_mod.get_llm() is sentinel


def test_get_llm_with_fallback_returns_wrapper(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "openai")
    monkeypatch.setitem(llm_mod._PROVIDERS, "ollama", lambda _t: _OkModel("a"))
    monkeypatch.setitem(llm_mod._PROVIDERS, "openai", lambda _t: _OkModel("b"))
    chat = llm_mod.get_llm()
    assert isinstance(chat, FailoverChat)
