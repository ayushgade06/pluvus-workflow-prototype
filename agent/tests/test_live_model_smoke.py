"""Opt-in live-model smoke tests (L1).

The rest of the suite injects a FakeLLM returning hardcoded JSON — it verifies
PLUMBING (schema retry, gates, decision math), not the MODEL. This file runs a
few real prompts through the actual configured model so there is at least a
minimal, opt-in signal that the live path produces sane, schema-valid output.

Skipped by default (needs a running model, e.g. Ollama). Enable with:
    RUN_LLM_EVAL=1 python -m pytest tests/test_live_model_smoke.py -q

These are SMOKE tests (sane shape / obvious cases), not an accuracy eval — the
model may occasionally disagree on a borderline case, so they assert only
high-confidence expectations to stay non-flaky. For a scored accuracy number,
see eval/run.py with RUN_LLM_EVAL=1.
"""

from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_LLM_EVAL") != "1",
    reason="set RUN_LLM_EVAL=1 (with a model available) to run live-model smoke tests",
)

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")


def test_live_classify_obvious_positive():
    from app.routes.classify import classify_message

    out = classify_message("Yes! I'd absolutely love to collaborate on this campaign.")
    # An unambiguous yes must not come back NEGATIVE/OPT_OUT from a real model.
    assert out.intent in ("POSITIVE", "QUESTION")
    assert 0.0 <= out.confidence <= 1.0


def test_live_classify_obvious_opt_out_is_forced_by_gate():
    from app.routes.classify import classify_message

    # The deterministic OPT_OUT gate runs before the model, so this is stable even
    # live — confirms the gate wins on the real path too.
    out = classify_message("Please unsubscribe me and stop emailing me.")
    assert out.intent == "OPT_OUT"


def test_live_draft_produces_valid_nonempty_email():
    from app.routes.negotiate import DraftRequest, _langgraph_draft

    req = DraftRequest(
        purpose="initial_outreach",
        creatorName="Alex",
        creatorPlatform="Instagram",
        creatorNiche="fitness",
        senderName="Acme Running",
        brandDescription="Acme Running makes premium running shoes for marathoners.",
    )
    out = _langgraph_draft(req)
    # Schema-valid, non-empty, and addressed to the creator by name.
    assert out.subject.strip()
    assert out.body.strip()
    assert "Alex" in out.body
    # The brand-neutral rule: never leaks "Pluvus" for a non-Pluvus sender.
    assert "pluvus" not in out.body.lower()


def test_live_negotiate_extracts_rate_and_decides_deterministically():
    from app.routes.negotiate import (
        CampaignConstraints,
        NegotiateRequest,
        NegotiationTerm,
        _langgraph_negotiate,
    )

    req = NegotiateRequest(
        creatorReply="Thanks! For a dedicated reel my rate would be $450.",
        currentOffer=NegotiationTerm(rate=300),
        round=0,
        maxRounds=5,
        negotiationHistory=[],
        campaignConstraints=CampaignConstraints(
            termFloor=NegotiationTerm(rate=200),
            termCeiling=NegotiationTerm(rate=600),
        ),
    )
    resp = _langgraph_negotiate(req)
    # $450 is within the [200, 600] band → a sane real model + deterministic
    # decision should COUNTER or ACCEPT, never REJECT/ESCALATE a workable rate.
    assert resp.action in ("COUNTER", "ACCEPT", "PRESENT_OFFER")
    assert resp.responseDraft and resp.responseDraft.strip()
