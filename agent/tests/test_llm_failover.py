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
    # Canonical local model is qwen3:30b-a3b (strongest local build) — the code
    # default is source of truth, and structured.py strips <think> blocks that
    # only qwen3 emits.
    assert _ollama_model_id() == "qwen3:30b-a3b"


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
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "anthropic")
    assert _candidate_chain() == ["ollama", "anthropic"]


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
    monkeypatch.setitem(llm_mod._PROVIDERS, "ollama", lambda _t, *_a, **_kw: sentinel)
    assert llm_mod.get_llm() is sentinel


def test_get_llm_with_fallback_returns_wrapper(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "anthropic")
    monkeypatch.setitem(llm_mod._PROVIDERS, "ollama", lambda _t, *_a, **_kw: _OkModel("a"))
    monkeypatch.setitem(llm_mod._PROVIDERS, "anthropic", lambda _t, *_a, **_kw: _OkModel("b"))
    chat = llm_mod.get_llm()
    assert isinstance(chat, FailoverChat)


# ---------------------------------------------------------------------------
# Per-role provider override (Claude on negotiate/classify, DeepSeek on draft)
# ---------------------------------------------------------------------------


def test_role_override_falls_back_to_global(monkeypatch):
    # A role with no LLM_PROVIDER_<ROLE> set inherits the global chain unchanged.
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.delenv("LLM_PROVIDER_DRAFT", raising=False)
    monkeypatch.delenv("LLM_FALLBACK_PROVIDER", raising=False)
    assert _candidate_chain("draft") == ["anthropic"]


def test_role_override_pins_own_provider(monkeypatch):
    # LLM_PROVIDER_DRAFT wins for the draft role only; the global (and other roles)
    # still resolve to the global provider.
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_PROVIDER_DRAFT", "deepseek")
    monkeypatch.delenv("LLM_FALLBACK_PROVIDER", raising=False)
    monkeypatch.delenv("LLM_FALLBACK_PROVIDER_DRAFT", raising=False)
    assert _candidate_chain("draft") == ["deepseek"]
    assert _candidate_chain("negotiate") == ["anthropic"]
    assert _candidate_chain() == ["anthropic"]


def test_role_override_supports_per_role_fallback(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_PROVIDER_DRAFT", "deepseek")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER_DRAFT", "anthropic")
    assert _candidate_chain("draft") == ["deepseek", "anthropic"]


def test_deepseek_provider_registered_and_labeled(monkeypatch):
    assert "deepseek" in llm_mod._PROVIDERS
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-chat")
    assert llm_mod._provider_label("deepseek") == "deepseek:deepseek-chat"


def test_get_llm_stamps_role_label_on_direct_model(monkeypatch):
    # The direct (no-fallback) model carries the resolved label so telemetry
    # reports the role's model, not the global default.
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_PROVIDER_DRAFT", "deepseek")
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-chat")
    monkeypatch.setitem(llm_mod._PROVIDERS, "deepseek", lambda _t, *_a, **_kw: _OkModel("draft"))
    model = llm_mod.get_llm(role="draft")
    assert llm_mod.current_model_label(model) == "deepseek:deepseek-chat"


def test_current_model_label_defaults_to_global_without_model(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-opus-4-8")
    assert llm_mod.current_model_label() == "anthropic:claude-opus-4-8"


# ---------------------------------------------------------------------------
# OpenRouter — single key/gateway, per-role model (Claude decisions / DeepSeek copy)
# ---------------------------------------------------------------------------


def test_openrouter_registered(monkeypatch):
    assert "openrouter" in llm_mod._PROVIDERS


def test_openrouter_model_per_role(monkeypatch):
    # One key, model chosen per role: Claude on the money path, DeepSeek on copy.
    monkeypatch.setenv("OPENROUTER_MODEL", "anthropic/claude-opus-4.1")
    monkeypatch.setenv("OPENROUTER_MODEL_DRAFT", "deepseek/deepseek-chat")
    assert llm_mod._openrouter_model("negotiate") == "anthropic/claude-opus-4.1"
    assert llm_mod._openrouter_model("classify") == "anthropic/claude-opus-4.1"
    assert llm_mod._openrouter_model("draft") == "deepseek/deepseek-chat"


def test_openrouter_label_is_role_aware(monkeypatch):
    monkeypatch.setenv("OPENROUTER_MODEL", "anthropic/claude-opus-4.1")
    monkeypatch.setenv("OPENROUTER_MODEL_DRAFT", "deepseek/deepseek-chat")
    assert llm_mod._provider_label("openrouter", "negotiate") == "openrouter:anthropic/claude-opus-4.1"
    assert llm_mod._provider_label("openrouter", "draft") == "openrouter:deepseek/deepseek-chat"


def test_openrouter_chain_all_roles_single_key(monkeypatch):
    # Global provider=openrouter → every role resolves to it (one key), and the
    # model differs by role via the model override, not the provider.
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    monkeypatch.delenv("LLM_PROVIDER_DRAFT", raising=False)
    for role in ("negotiate", "classify", "draft"):
        assert _candidate_chain(role) == ["openrouter"]


def test_openrouter_missing_key_raises(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("LLM_PROVIDER", "openrouter")
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY is not set"):
        llm_mod.get_llm(role="negotiate")
