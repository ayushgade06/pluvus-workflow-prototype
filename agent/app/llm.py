"""
LLM provider switch with failover + model pinning for the agent service.

Every route (classify, negotiate, draft) gets its chat model from get_llm().
Switching providers is env-only — no code edits:

    LLM_PROVIDER=ollama      # local dev, Qwen via Ollama
    LLM_PROVIDER=anthropic   # prod, Claude — set ANTHROPIC_API_KEY (default)
    LLM_PROVIDER=deepseek    # DeepSeek cloud (OpenAI-compatible) — DEEPSEEK_API_KEY

Per-TASK provider override (mixed-model deployments):
    Each call site passes a role — "negotiate" | "classify" | "draft". A role can
    pin its OWN provider chain via env, falling back to the global LLM_PROVIDER
    when unset. This lets one deployment run e.g. Claude on the money/decision path
    and a cheaper model for email copy, still env-only, no code edits:

        LLM_PROVIDER=anthropic          # global default (negotiate + classify)
        LLM_PROVIDER_DRAFT=deepseek     # drafting only → DeepSeek cloud

    Recognized role overrides: LLM_PROVIDER_NEGOTIATE, LLM_PROVIDER_CLASSIFY,
    LLM_PROVIDER_DRAFT (and matching LLM_FALLBACK_PROVIDER_<ROLE> for per-role
    failover). An unset role override inherits the global chain unchanged, so
    existing single-provider deployments behave exactly as before.

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
    Ollama:     OLLAMA_MODEL (default "qwen3:30b-a3b"), OLLAMA_MODEL_DIGEST (optional),
                OLLAMA_BASE_URL (default http://localhost:11434)
    Anthropic:  ANTHROPIC_MODEL (default "claude-opus-4-8"), ANTHROPIC_API_KEY (required).
                Set ANTHROPIC_MODEL=claude-haiku-4-5 for the fast/cheap tier or
                claude-opus-4-8 for the most capable — same code, env-only switch.
    DeepSeek:   DEEPSEEK_MODEL (default "deepseek-chat"), DEEPSEEK_API_KEY (required),
                DEEPSEEK_BASE_URL (default https://api.deepseek.com). OpenAI-compatible,
                so it rides langchain-openai's ChatOpenAI — no extra SDK. Use
                "deepseek-chat" (V3) for copy/drafting; "deepseek-reasoner" (R1) if a
                path ever needs chain-of-thought.

Imports are lazy so you only need the SDK for the provider(s) you actually
select — running local Qwen never imports / requires langchain-anthropic.
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
    model = os.getenv("OLLAMA_MODEL", "qwen3:30b-a3b")
    digest = os.getenv("OLLAMA_MODEL_DIGEST", "").strip()
    if digest:
        # Tolerate the digest being given with or without the sha256: prefix.
        ref = digest if digest.startswith("sha256:") else f"sha256:{digest}"
        return f"{model}@{ref}"
    return model


def _env_flag(name: str, default: bool) -> bool:
    """Parse a boolean env var. Accepts 1/true/yes/on (any case) as True."""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _parse_keep_alive(raw: str | None):
    """Normalize OLLAMA_KEEP_ALIVE for the Ollama API.

    Ollama accepts keep_alive as either an integer number of SECONDS (with -1 =
    forever, 0 = unload now) OR a Go duration STRING that MUST carry a unit
    ("30m", "1h"). A unit-less string like "-1"/"300" is rejected with HTTP 400
    "missing unit in duration". So a purely-numeric value is returned as an int;
    anything with a unit is passed through as the trimmed string. Empty/None
    defaults to -1 (pin forever).
    """
    s = (raw or "").strip()
    if s == "":
        return -1
    try:
        return int(s)  # "-1", "0", "300" -> int seconds (no unit needed)
    except ValueError:
        return s  # "30m", "1h", "90s" -> Go duration string


def _make_ollama(temperature: float, num_predict_override: int | None = None, role: str | None = None):
    from langchain_ollama import ChatOllama  # type: ignore[import]

    # qwen3 is a HYBRID REASONING model — left to its defaults it emits a long
    # <think>…</think> block before the JSON. On the classify/negotiate/draft
    # paths that reasoning is pure latency: the routes want a structured decision,
    # not a visible chain of thought. On a box where the 30B runs mostly on CPU a
    # single classify was measured at ~287s almost entirely inside <think>, which
    # blew the interactive timeout and truncated the block so no JSON parsed →
    # StructuredOutputError → UNKNOWN/confidence-0 → every real reply dumped to
    # MANUAL_REVIEW. reasoning=False sets Ollama's `think: false` so the model
    # answers directly; the structured.py <think> stripper still handles any model
    # that ignores the flag. Override with OLLAMA_REASONING=true to study a chain.
    reasoning = _env_flag("OLLAMA_REASONING", default=False)
    # Default context window (Ollama's own default is 4096). The prompt + a short
    # structured answer fit comfortably in 8k; bump via OLLAMA_NUM_CTX if needed.
    num_ctx = _env_int("OLLAMA_NUM_CTX", 8192)
    # Keep the model resident between calls. Ollama unloads a model after ~5min
    # idle by default; reloading a large model blew the interactive timeout on the
    # FIRST reply after any gap. -1 pins it in memory indefinitely; override with
    # OLLAMA_KEEP_ALIVE (e.g. "30m", or "0" to unload immediately). This is a big
    # latency win. NOTE: Ollama parses a *string* keep_alive as a Go duration and
    # REJECTS "-1"/"0" (no unit) with 400 "missing unit in duration"; a bare
    # integer means seconds (and -1 = forever). So pass a plain integer through as
    # an int, and only pass unit-bearing strings ("30m", "1h") as strings.
    keep_alive = _parse_keep_alive(os.getenv("OLLAMA_KEEP_ALIVE", "-1"))
    # Hard cap on generated tokens. classify/negotiate/draft emit a JSON object
    # (an intent + one-sentence reason, or a short email) — without a cap the
    # CPU-bound model (~4 tok/s here) can ramble for hundreds of tokens and run
    # for minutes. MED-L2: the default is raised from 512 to 768 because the
    # llm-negotiate output (action + rate + a full ready-to-send email + reasoning
    # + creatorQuestions + pushedFixedTerms) is the LONGEST structured JSON we ask
    # for, and 512 could truncate it MID-STRING → invalid JSON → wasted retries or
    # a needless fallback. A per-call override (num_predict_override, passed by the
    # negotiate route) can raise it further for that path without inflating the
    # cheap classify call. OLLAMA_NUM_PREDICT still sets the global default.
    num_predict = num_predict_override or _env_int("OLLAMA_NUM_PREDICT", 768)
    # MED-L3 (real determinism): pin a seed + top_p and force JSON mode so
    # "identical inputs yield identical decisions" is actually TRUE, not just
    # claimed. Without a seed the sampler varies run to run even at temperature 0
    # on some backends; format="json" constrains the decode to valid JSON (fewer
    # brace-scrape retries). All three are overridable via env for experiments.
    seed = _env_int("OLLAMA_SEED", 42)
    top_p = _env_float("OLLAMA_TOP_P", 1.0)
    # format="json" is Ollama's structured-output constraint. Disable with
    # OLLAMA_JSON_MODE=false if a prompt ever needs free-text (none do today).
    json_mode = _env_flag("OLLAMA_JSON_MODE", default=True)

    kwargs = dict(
        model=_ollama_model_id(),
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        temperature=temperature,
        reasoning=reasoning,
        num_ctx=num_ctx,
        num_predict=num_predict,
        keep_alive=keep_alive,
        seed=seed,
        top_p=top_p,
    )
    if json_mode:
        kwargs["format"] = "json"
    return ChatOllama(**kwargs)


# Claude model families that REJECT sampling params (temperature/top_p) with a
# 400: the Opus 4.7+/Fable tier is adaptive-thinking-only. Haiku and Sonnet still
# accept temperature. We detect by model-id substring so a `temperature=` kwarg is
# only passed to a model that actually accepts it — otherwise the call 400s.
_ANTHROPIC_NO_SAMPLING_PARAMS = ("opus-4-8", "opus-4-7", "fable", "mythos")


def _anthropic_accepts_temperature(model: str) -> bool:
    m = model.lower()
    return not any(tag in m for tag in _ANTHROPIC_NO_SAMPLING_PARAMS)


def _make_anthropic(temperature: float, num_predict_override: int | None = None, role: str | None = None):
    try:
        from langchain_anthropic import ChatAnthropic  # type: ignore[import]
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise RuntimeError(
            "LLM_PROVIDER=anthropic but langchain-anthropic is not installed. "
            "Run: pip install langchain-anthropic"
        ) from exc

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.")

    # ANTHROPIC_MODEL is itself the pin — use an exact model id from the Claude
    # catalog (claude-opus-4-8 most capable, claude-haiku-4-5 fastest/cheapest).
    # Default to the most capable Opus tier; a deployment can drop to Haiku for
    # cost via env with no code change.
    model = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-8")

    # MED-L2: cap output tokens on the same rationale as Ollama's num_predict, so
    # the verbose llm-negotiate JSON isn't truncated mid-string. The negotiate
    # route passes a larger override for its path.
    max_tokens = num_predict_override or _env_int("ANTHROPIC_MAX_TOKENS", 768)

    kwargs = dict(
        model=model,
        api_key=api_key,
        max_tokens=max_tokens,
        timeout=_env_float("ANTHROPIC_TIMEOUT_SECONDS", 60.0),
        max_retries=_env_int("ANTHROPIC_MAX_RETRIES", 2),
    )
    # Claude has no OpenAI-style `response_format` JSON mode — the prompts already
    # say "return ONLY JSON" and structured.py extracts + repairs the object, so
    # no server-side JSON constraint is needed. Only pass temperature to a model
    # that accepts it (Opus 4.7+/Fable are adaptive-thinking-only and 400 on it).
    if _anthropic_accepts_temperature(model):
        kwargs["temperature"] = temperature
    return ChatAnthropic(**kwargs)


def _make_deepseek(temperature: float, num_predict_override: int | None = None, role: str | None = None):
    """DeepSeek via its OpenAI-compatible endpoint, on langchain-openai's ChatOpenAI.

    DeepSeek ships an OpenAI-compatible API, so it needs NO new SDK — ChatOpenAI
    pointed at DEEPSEEK_BASE_URL with a DEEPSEEK_API_KEY is the whole integration.
    Used on the drafting/copy path (temperature 0.7) where V3's writing is strong
    and cheap; the money/decision path stays on Claude via the per-role override.
    """
    try:
        from langchain_openai import ChatOpenAI  # type: ignore[import]
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise RuntimeError(
            "LLM provider 'deepseek' requires langchain-openai. "
            "Run: pip install langchain-openai"
        ) from exc

    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("LLM provider 'deepseek' selected but DEEPSEEK_API_KEY is not set.")

    # DEEPSEEK_MODEL is the pin — "deepseek-chat" (V3) for copy, "deepseek-reasoner"
    # (R1) if a path ever needs a visible chain of thought. DeepSeek supports the
    # OpenAI response_format json_object mode, but the drafting prompt wants free
    # text (an email), and structured.py still repairs/extracts JSON on the paths
    # that need it, so we don't force server-side JSON here.
    model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
    max_tokens = num_predict_override or _env_int("DEEPSEEK_MAX_TOKENS", 768)

    return ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=_env_float("DEEPSEEK_TIMEOUT_SECONDS", 60.0),
        max_retries=_env_int("DEEPSEEK_MAX_RETRIES", 2),
    )


# OpenRouter is a single OpenAI-compatible gateway that proxies MANY upstreams
# (Anthropic, DeepSeek, etc.) behind ONE key + ONE base URL. You pick the upstream
# by the MODEL ID string ("anthropic/claude-opus-4.1", "deepseek/deepseek-chat"),
# not by a different provider/key. So — unlike the anthropic/deepseek factories —
# a single `openrouter` provider serves EVERY role; the model is chosen PER ROLE.
_openrouter_model_for_role_logged: set[str | None] = set()


def _openrouter_model(role: str | None) -> str:
    """Resolve the OpenRouter model id for a role.

    OPENROUTER_MODEL_<ROLE> wins; else OPENROUTER_MODEL (global default). This is
    how the Claude-decisions / DeepSeek-copy split is expressed on a single key:
        OPENROUTER_MODEL=anthropic/claude-opus-4.1     # negotiate + classify
        OPENROUTER_MODEL_DRAFT=deepseek/deepseek-chat  # drafting
    """
    scoped = _role_env("OPENROUTER_MODEL", role)
    return scoped or "anthropic/claude-opus-4.1"


def _make_openrouter(temperature: float, num_predict_override: int | None = None, role: str | None = None):
    """All roles via OpenRouter's OpenAI-compatible gateway on one OPENROUTER_API_KEY.

    The per-role model (Claude for the money path, DeepSeek for copy) is selected by
    OPENROUTER_MODEL_<ROLE>. Reuses ChatOpenAI — no new SDK.
    """
    try:
        from langchain_openai import ChatOpenAI  # type: ignore[import]
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise RuntimeError(
            "LLM provider 'openrouter' requires langchain-openai. "
            "Run: pip install langchain-openai"
        ) from exc

    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("LLM provider 'openrouter' selected but OPENROUTER_API_KEY is not set.")

    model = _openrouter_model(role)
    max_tokens = num_predict_override or _env_int("OPENROUTER_MAX_TOKENS", 768)

    # OpenRouter recommends (not requires) HTTP-Referer + X-Title headers for
    # attribution/rate-limit tiering; harmless if omitted. Set via env if wanted.
    default_headers = {}
    referer = os.getenv("OPENROUTER_HTTP_REFERER", "").strip()
    title = os.getenv("OPENROUTER_APP_TITLE", "").strip()
    if referer:
        default_headers["HTTP-Referer"] = referer
    if title:
        default_headers["X-Title"] = title

    kwargs = dict(
        model=model,
        api_key=api_key,
        base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=_env_float("OPENROUTER_TIMEOUT_SECONDS", 60.0),
        max_retries=_env_int("OPENROUTER_MAX_RETRIES", 2),
    )
    if default_headers:
        kwargs["default_headers"] = default_headers
    return ChatOpenAI(**kwargs)


_PROVIDERS = {
    "ollama": _make_ollama,
    "anthropic": _make_anthropic,
    "deepseek": _make_deepseek,
    "openrouter": _make_openrouter,
}


def _provider_label(provider: str, role: str | None = None) -> str:
    """Human-readable model identity for logs (no secrets)."""
    if provider == "ollama":
        return f"ollama:{_ollama_model_id()}"
    if provider == "anthropic":
        return f"anthropic:{os.getenv('ANTHROPIC_MODEL', 'claude-opus-4-8')}"
    if provider == "deepseek":
        return f"deepseek:{os.getenv('DEEPSEEK_MODEL', 'deepseek-chat')}"
    if provider == "openrouter":
        # The model is role-dependent (Claude vs DeepSeek on one key), so the label
        # names the resolved model for THIS role.
        return f"openrouter:{_openrouter_model(role)}"
    return provider


def current_model_label(llm: object | None = None) -> str:
    """HARD-O1: model identity for the direct (no-fallback) telemetry path.

    Prefer the label stamped on the model when get_llm() built it — that carries
    the per-ROLE provider (e.g. deepseek on the draft path even when the global
    LLM_PROVIDER is anthropic). Only when no model is passed (or it wasn't stamped)
    do we fall back to the global primary's label. The failover path stamps each
    candidate's own label; the direct path only ever uses the primary."""
    stamped = getattr(llm, "_agent_model_label", None)
    if stamped:
        return stamped
    return _provider_label(_candidate_chain()[0])


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

    MED-L2 — per-candidate timeout. Each candidate's ``.invoke`` runs under its
    OWN wall-clock budget (LLM_INVOKE_TIMEOUT_SECONDS). Previously a single budget
    in structured.py wrapped the whole failover chain, so a hung PRIMARY consumed
    the entire budget and the fallback never got a chance to run. Bounding each
    candidate independently means a stuck primary times out and the fallback then
    runs with a fresh budget — the failover actually works under a hang, not just
    under an immediate error.
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
        # HARD-O1: instrument every LLM invoke with latency + token/cost telemetry,
        # stamped with {model, promptVersion}. Imported lazily to keep llm.py free
        # of a hard telemetry dependency (and to avoid import cycles).
        import time

        from app.telemetry import (
            SpendCapExceeded,
            get_active_prompt_version,
            record_llm_call,
        )

        errors: list[str] = []
        prompt_version = get_active_prompt_version()
        for idx, (label, factory) in enumerate(self._candidates):
            start = time.perf_counter()
            try:
                model = self._model_for(label, factory)
                # Per-candidate wall-clock bound (imported here to avoid a circular
                # import: structured.py imports get_llm indirectly via the routes).
                from app.structured import invoke_model_bounded

                result = invoke_model_bounded(model, prompt)
                if idx > 0:
                    logger.warning("LLM failover: served by fallback %s", label)
                # record_llm_call runs the P4 spend guard; if it raises
                # SpendCapExceeded the request has already spent its budget, so we
                # must NOT fall over to the next candidate (that would spend MORE).
                # Let it propagate straight out of the failover loop (see below).
                record_llm_call(
                    model=label,
                    latency_ms=(time.perf_counter() - start) * 1000.0,
                    result=result,
                    prompt_version=prompt_version,
                    ok=True,
                )
                return result
            except SpendCapExceeded:
                # Budget hit — stop the whole chain, don't try the fallback and
                # don't double-record (the tipping call was already recorded).
                raise
            except Exception as exc:  # noqa: BLE001 — any failure should try the next
                errors.append(f"{label}: {exc}")
                logger.warning("LLM candidate %s failed: %s", label, exc)
                # Record the failed candidate too (latency + error kind), so the
                # error rate + failover behavior are observable, not just the wins.
                record_llm_call(
                    model=label,
                    latency_ms=(time.perf_counter() - start) * 1000.0,
                    result=None,
                    prompt_version=prompt_version,
                    ok=False,
                    error_kind=type(exc).__name__,
                )
                continue
        raise RuntimeError(
            "all LLM candidates failed: " + " | ".join(errors)
        )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def _role_env(base: str, role: str | None) -> str:
    """Read a per-role env override, falling back to the global var.

    e.g. _role_env("LLM_PROVIDER", "draft") reads LLM_PROVIDER_DRAFT and, if that
    is unset/blank, LLM_PROVIDER. An unset role (role=None) reads the global only,
    so nothing changes for callers that don't pass a role.
    """
    if role:
        scoped = os.getenv(f"{base}_{role.strip().upper()}", "").strip()
        if scoped:
            return scoped
    return os.getenv(base, "").strip()


def _candidate_chain(role: str | None = None) -> list[str]:
    """Ordered list of provider names: primary then optional fallback.

    A role ("negotiate" | "classify" | "draft") lets a single deployment pin a
    DIFFERENT provider per task via LLM_PROVIDER_<ROLE> (and LLM_FALLBACK_PROVIDER_
    <ROLE>), inheriting the global LLM_PROVIDER when the override is unset.

    Duplicates and blanks are dropped, so a fallback == primary is a harmless
    no-op rather than a pointless double-try.
    """
    primary = (_role_env("LLM_PROVIDER", role) or "ollama").lower()
    chain = [primary]
    fallback = _role_env("LLM_FALLBACK_PROVIDER", role).lower()
    if fallback and fallback != primary:
        chain.append(fallback)
    return chain


_pinning_logged_roles: set[str | None] = set()


def get_llm(temperature: float = 0.2, num_predict: int | None = None, role: str | None = None):
    """Return a chat model for the configured provider chain.

    With no fallback configured this returns the primary model directly (zero
    overhead, identical behavior to before FIX-8). With LLM_FALLBACK_PROVIDER set
    it returns a FailoverChat that tries primary → fallback on each invoke.

    ``num_predict`` (MED-L2) is an optional per-call cap on generated tokens
    (Ollama ``num_predict`` / OpenAI ``max_tokens``). The negotiate route passes a
    larger value than the default so the verbose llm-negotiate JSON isn't
    truncated mid-string; classify/draft leave it None and use the global default.

    ``role`` selects a per-task provider chain (LLM_PROVIDER_<ROLE>, else the
    global LLM_PROVIDER) so one deployment can, e.g., run Claude on the negotiate/
    classify path and DeepSeek on the draft path. Unset role → global chain, so
    existing callers are unchanged. The resolved primary label is stamped on the
    returned model as ``_agent_model_label`` so the direct-path telemetry in
    structured.py reports the ROLE's model, not the global default.

    Raises a clear RuntimeError if a provider name is unknown. Prerequisite
    errors (missing SDK / API key) for the PRIMARY surface eagerly; for a
    fallback they surface only if the primary actually fails over to it.
    """
    chain = _candidate_chain(role)
    for provider in chain:
        if provider not in _PROVIDERS:
            raise RuntimeError(
                f"Unknown LLM provider {provider!r}. Supported: {', '.join(_PROVIDERS)}."
            )

    # Log the resolved chain once PER ROLE (so a mixed deployment logs each task's
    # pinned model exactly once, not just the first role that happens to run).
    if role not in _pinning_logged_roles:
        labels = " -> ".join(_provider_label(p, role) for p in chain)
        logger.info("LLM chain (pinned)%s: %s", f" [{role}]" if role else "", labels)
        _pinning_logged_roles.add(role)

    primary_label = _provider_label(chain[0], role)

    # Bind num_predict + role into each factory so both the direct and failover
    # paths honor the per-call cap and the per-role model. role is passed as a
    # keyword; every factory accepts (temperature, num_predict_override=None,
    # role=None), so a factory that ignores role (ollama/anthropic/deepseek) is
    # unaffected while openrouter uses it to pick its per-role model.
    def _bind(provider: str):
        factory = _PROVIDERS[provider]
        return lambda temperature: factory(temperature, num_predict, role=role)

    if len(chain) == 1:
        # No fallback — keep the direct model (no wrapper) for zero overhead.
        model = _bind(chain[0])(temperature)
        # Stamp the role's resolved label so telemetry (structured.py direct path)
        # reports THIS model. Best-effort: some model objects forbid new attrs.
        try:
            model._agent_model_label = primary_label
        except Exception:  # noqa: BLE001 — telemetry label is non-critical
            pass
        return model

    candidates = [(_provider_label(p, role), _bind(p)) for p in chain]
    return FailoverChat(candidates, temperature)
