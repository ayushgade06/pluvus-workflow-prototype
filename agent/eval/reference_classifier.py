"""
Deterministic reference classifier for the eval gate (FIX-5).

The accuracy gate must be runnable in CI with no model and no network. This
classifier provides that: it reuses the production injection/OPT_OUT gates from
``app.injection`` (so the eval actually exercises the FIX-7 security path) and
adds keyword matching that mirrors the TS MockClassificationProvider for the
remaining intents.

It is intentionally the SAME logic as the rule-based path the system falls back
to, so the CI accuracy number reflects a real production code path — not a toy.
For an LLM accuracy number, the same eval set is run through the live
``classify_message`` (opt-in via env in the gate test).
"""

from __future__ import annotations

from app.injection import (
    looks_like_injection,
    looks_like_opt_out,
    sanitize_creator_text,
)

# Keyword lists mirror server/src/adapters/classification/MockClassificationProvider.ts
_POSITIVE = [
    "yes", "interested", "love to", "sounds great", "definitely", "absolutely",
    "would love", "happy to", "excited", "let's do it", "let's make it", "count me in",
    "sure", "i'm in", "im in", "on board", "glad to", "good fit",
]
_NEGATIVE = [
    "not interested", "no thanks", "no thank you", "decline", "pass",
    "don't want", "dont want", "not at this time", "not right now", "have to say no",
    "going to say no", "doesn't align", "isn't a fit", "not a fit",
]
_QUESTION = [
    "?", "what is", "what are", "what kind", "how much", "how does", "tell me more",
    "can you", "could you", "would you be able", "commission", "rate", "details",
    "what does", "who is", "when", "where", "budget", "deliverable", "timeline",
]


def _matches(lower: str, keywords: list[str]) -> bool:
    return any(kw in lower for kw in keywords)


def reference_classify(message: str) -> str:
    """Return one of the five intents using the deterministic rule path.

    Mirrors the order of the production classify_message gates: sanitize →
    OPT_OUT (forced) → injection (→ UNKNOWN) → keyword match → UNKNOWN.
    """
    clean = sanitize_creator_text(message)

    if looks_like_opt_out(clean):
        return "OPT_OUT"
    if looks_like_injection(clean):
        return "UNKNOWN"

    lower = clean.lower()
    # Negative before positive: "not interested" contains "interested".
    if _matches(lower, _NEGATIVE):
        return "NEGATIVE"
    if _matches(lower, _POSITIVE):
        return "POSITIVE"
    if _matches(lower, _QUESTION):
        return "QUESTION"
    return "UNKNOWN"
