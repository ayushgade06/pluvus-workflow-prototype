"""
LLM provider switch with failover + model pinning for the agent service.

Every route (classify, negotiate, draft) gets its chat model from get_llm().
Switching providers is env-only — no code edits:

    LLM_PROVIDER=ollama   # local dev, Qwen via Ollama (default)
    LLM_PROVIDER=openai   # prod, OpenAI — set OPENAI_API_KEY

FIX-8 — production hardening:

  * **Failover.** Set LLM_FALLBACK_PROVIDER (and its model/key env) to add a
    secondary. get_llm() then returns a wrapper that tries the primary on every
    invoke and, if it raises, falls over to the secondary (logged). A model
    that is constructed but fails at call time (backend down, timeout, 5xx) is
    handled at invoke, which is where real failures surface.

  * **Model pinning + logging.** The resolved provider/model (and the optional
    pinned Ollama digest) are logged once at construction, so the active model
    version is auditable. Pin an immutable Ollama digest with OLLAMA_MODEL_DIGEST
    (e.g. "sha256:...") to defeat silent model-tag updates; OpenAI is pinned by
    the exact OPENAI_MODEL id.

Provider-specific knobs:
    Ollama:  OLLAMA_MODEL (default "qwen2.5:7b"), OLLAMA_MODEL_DIGEST (optional),
             OLLAMA_BASE_URL (default http://localhost:11434)
    OpenAI:  OPENAI_MODEL (default "gpt-4o-mini"), OPENAI_API_KEY (required)

Imports are lazy so you only need the SDK for the provider(s) you actually
select — running local Qwen never imports / requires langchain-openai.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("agent.llm")


# ---------------------------------------------------------------------------
# Provider factories (lazy imports — only the selected SDK is required)
# ---------------------------------------------------------------------------


def _ollama_model_id() -> str:
    """Resolve the Ollama model id, pinning to an immutable digest when set.

    Ollama accepts `model@sha256:<digest>` to pin a specific build of a tag, so
    a later `ollama pull` of the same tag can't silently change behavior on the
    decision path (audit Determinism finding).
    """
    model = os.getenv("OLLAMA_MODEL", "qwen3:8b")
    digest = os.getenv("OLLAMA_MODEL_DIGEST", "").strip()
    if digest:
        # Tolerate the digest being given with or without the sha256: prefix.
        ref = digest if digest.startswith("sha256:") else f"sha256:{digest}"
        return f"{model}@{ref}"
    return model


def _make_ollama(temperature: float):
    from langchain_ollama import ChatOllama  # type: ignore[import]

    return ChatOllama(
        model=_ollama_model_id(),
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        temperature=temperature,
    )


def _make_openai(temperature: float):
    try:
        from langchain_openai import ChatOpenAI  # type: ignore[import]
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise RuntimeError(
            "LLM_PROVIDER=openai but langchain-openai is not installed. "
            "Run: pip install langchain-openai"
        ) from exc

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("LLM_PROVIDER=openai but OPENAI_API_KEY is not set.")

    return ChatOpenAI(
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        api_key=api_key,
        temperature=temperature,
    )


_PROVIDERS = {
    "ollama": _make_ollama,
    "openai": _make_openai,
}


def _provider_label(provider: str) -> str:
    """Human-readable model identity for logs (no secrets)."""
    if provider == "ollama":
        return f"ollama:{_ollama_model_id()}"
    if provider == "openai":
        return f"openai:{os.getenv('OPENAI_MODEL', 'gpt-4o-mini')}"
    return provider


# ---------------------------------------------------------------------------
# Failover wrapper
# ---------------------------------------------------------------------------


class FailoverChat:
    """Chat model that tries an ordered list of (label, factory) candidates.

    Implements the subset of the LangChain chat interface the agent uses:
    ``invoke(prompt)`` returning an object with a ``.content`` attribute. The
    underlying model for a candidate is built lazily on first use and cached, so
    constructing the wrapper never fails just because a fallback SDK is absent —
    that only matters if the primary actually fails over to it.
    """

    def __init__(self, candidates: list[tuple[str, object]], temperature: float) -> None:
        # candidates: list of (label, factory) where factory(temperature) -> model
        self._candidates = candidates
        self._temperature = temperature
        self._cache: dict[str, object] = {}

    def _model_for(self, label: str, factory) -> object:
        if label not in self._cache:
            self._cache[label] = factory(self._temperature)
        return self._cache[label]

    def invoke(self, prompt):
        errors: list[str] = []
        for idx, (label, factory) in enumerate(self._candidates):
            try:
                model = self._model_for(label, factory)
                result = model.invoke(prompt)
                if idx > 0:
                    logger.warning("LLM failover: served by fallback %s", label)
                return result
            except Exception as exc:  # noqa: BLE001 — any failure should try the next
                errors.append(f"{label}: {exc}")
                logger.warning("LLM candidate %s failed: %s", label, exc)
                continue
        raise RuntimeError(
            "all LLM candidates failed: " + " | ".join(errors)
        )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

_pinning_logged = False


def _candidate_chain() -> list[str]:
    """Ordered list of provider names: primary then optional fallback.

    Duplicates and blanks are dropped, so LLM_FALLBACK_PROVIDER == LLM_PROVIDER
    is a harmless no-op rather than a pointless double-try.
    """
    primary = os.getenv("LLM_PROVIDER", "ollama").strip().lower()
    chain = [primary]
    fallback = os.getenv("LLM_FALLBACK_PROVIDER", "").strip().lower()
    if fallback and fallback != primary:
        chain.append(fallback)
    return chain


def get_llm(temperature: float = 0.2):
    """Return a chat model for the configured provider chain.

    With no fallback configured this returns the primary model directly (zero
    overhead, identical behavior to before FIX-8). With LLM_FALLBACK_PROVIDER set
    it returns a FailoverChat that tries primary → fallback on each invoke.

    Raises a clear RuntimeError if a provider name is unknown. Prerequisite
    errors (missing SDK / API key) for the PRIMARY surface eagerly; for a
    fallback they surface only if the primary actually fails over to it.
    """
    global _pinning_logged

    chain = _candidate_chain()
    for provider in chain:
        if provider not in _PROVIDERS:
            raise RuntimeError(
                f"Unknown LLM provider {provider!r}. Supported: {', '.join(_PROVIDERS)}."
            )

    if not _pinning_logged:
        labels = " -> ".join(_provider_label(p) for p in chain)
        logger.info("LLM chain (pinned): %s", labels)
        _pinning_logged = True

    if len(chain) == 1:
        # No fallback — keep the direct model (no wrapper) for zero overhead.
        return _PROVIDERS[chain[0]](temperature)

    candidates = [(_provider_label(p), _PROVIDERS[p]) for p in chain]
    return FailoverChat(candidates, temperature)
