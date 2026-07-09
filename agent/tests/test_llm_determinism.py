"""Tests for MED-L2 (num_predict threading) + MED-L3 (real determinism).

The audit found the determinism claim ("identical inputs yield identical
decisions") was overclaimed: no seed, no JSON mode, no top_p pin. These assert
the Ollama factory now sets seed + top_p + format="json" and honors a per-call
num_predict override, so the claim is actually enforced.

Uses a fake ChatOllama that captures kwargs — no Ollama server / network needed.
"""

from __future__ import annotations

import sys
import types

import pytest

from app import llm as llm_mod


class _FakeChatOllama:
    """Captures the kwargs _make_ollama passes so we can assert on them."""

    last_kwargs: dict = {}

    def __init__(self, **kwargs):
        type(self).last_kwargs = kwargs


@pytest.fixture
def fake_ollama(monkeypatch):
    # _make_ollama does `from langchain_ollama import ChatOllama`, so inject a
    # fake module into sys.modules for the duration of the test.
    mod = types.ModuleType("langchain_ollama")
    mod.ChatOllama = _FakeChatOllama
    monkeypatch.setitem(sys.modules, "langchain_ollama", mod)
    _FakeChatOllama.last_kwargs = {}
    return _FakeChatOllama


def test_ollama_pins_seed_top_p_and_json_mode(monkeypatch, fake_ollama):
    # No env overrides → the pinned determinism defaults.
    for var in ("OLLAMA_SEED", "OLLAMA_TOP_P", "OLLAMA_JSON_MODE", "OLLAMA_NUM_PREDICT"):
        monkeypatch.delenv(var, raising=False)
    llm_mod._make_ollama(temperature=0)
    kw = fake_ollama.last_kwargs
    assert kw["seed"] == 42
    assert kw["top_p"] == 1.0
    assert kw["temperature"] == 0
    assert kw["format"] == "json"  # JSON mode on by default (MED-L3)


def test_ollama_json_mode_can_be_disabled(monkeypatch, fake_ollama):
    monkeypatch.setenv("OLLAMA_JSON_MODE", "false")
    llm_mod._make_ollama(temperature=0)
    assert "format" not in fake_ollama.last_kwargs


def test_ollama_seed_and_top_p_overridable(monkeypatch, fake_ollama):
    monkeypatch.setenv("OLLAMA_SEED", "7")
    monkeypatch.setenv("OLLAMA_TOP_P", "0.8")
    llm_mod._make_ollama(temperature=0)
    assert fake_ollama.last_kwargs["seed"] == 7
    assert fake_ollama.last_kwargs["top_p"] == 0.8


def test_ollama_default_num_predict_is_raised_to_768(monkeypatch, fake_ollama):
    # MED-L2: default raised from 512 → 768 so the verbose negotiate JSON isn't
    # truncated even without an explicit override.
    monkeypatch.delenv("OLLAMA_NUM_PREDICT", raising=False)
    llm_mod._make_ollama(temperature=0)
    assert fake_ollama.last_kwargs["num_predict"] == 768


def test_ollama_num_predict_override_wins(monkeypatch, fake_ollama):
    # A per-call override (passed by the negotiate route) beats the env default.
    monkeypatch.setenv("OLLAMA_NUM_PREDICT", "768")
    llm_mod._make_ollama(temperature=0, num_predict_override=1024)
    assert fake_ollama.last_kwargs["num_predict"] == 1024


def test_get_llm_threads_num_predict_to_direct_model(monkeypatch, fake_ollama):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    monkeypatch.delenv("LLM_FALLBACK_PROVIDER", raising=False)
    llm_mod.get_llm(temperature=0.3, num_predict=1024)
    assert fake_ollama.last_kwargs["num_predict"] == 1024


def test_env_float_helper(monkeypatch):
    monkeypatch.setenv("X", "0.9")
    assert llm_mod._env_float("X", 1.0) == 0.9
    monkeypatch.setenv("X", "nan-ish")
    assert llm_mod._env_float("X", 1.0) == 1.0
    monkeypatch.delenv("X", raising=False)
    assert llm_mod._env_float("X", 1.0) == 1.0
