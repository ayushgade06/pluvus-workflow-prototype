"""
Single LLM provider switch for the agent service.

Every route (classify, negotiate, draft) gets its chat model from get_llm().
Switching providers is ONE env var — no code edits:

    LLM_PROVIDER=ollama   # local dev, Qwen via Ollama (default)
    LLM_PROVIDER=openai   # prod, OpenAI — set OPENAI_API_KEY

Provider-specific knobs:
    Ollama:  OLLAMA_MODEL (default "qwen2.5:7b"), OLLAMA_BASE_URL (default http://localhost:11434)
    OpenAI:  OPENAI_MODEL (default "gpt-4o-mini"), OPENAI_API_KEY (required)

Imports are lazy so you only need the SDK for the provider you actually select —
running local Qwen never imports / requires langchain-openai, and vice versa.
"""

from __future__ import annotations

import os


def _make_ollama(temperature: float):
    from langchain_ollama import ChatOllama  # type: ignore[import]

    return ChatOllama(
        model=os.getenv("OLLAMA_MODEL", "qwen2.5:7b"),
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


def get_llm(temperature: float = 0.2):
    """Return a LangChain chat model for the configured LLM_PROVIDER.

    Raises a clear RuntimeError if the provider is unknown or its prerequisites
    (SDK / API key) are missing — never silently falls back to another provider.
    """
    provider = os.getenv("LLM_PROVIDER", "ollama").strip().lower()
    factory = _PROVIDERS.get(provider)
    if factory is None:
        raise RuntimeError(
            f"Unknown LLM_PROVIDER={provider!r}. Supported: {', '.join(_PROVIDERS)}."
        )
    return factory(temperature)
