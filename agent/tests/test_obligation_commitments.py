"""PLU-111 — the /draft and /negotiate prompts render outstanding Pluvus
commitments as an additive block, and omit it (byte-identical to before) when
none are threaded.

These are pure prompt-shape assertions — no model call, no network.
"""

from app.routes.negotiate import (
    DraftRequest,
    NegotiateRequest,
    NegotiationTerm,
    CampaignConstraints,
    _build_offer_prompt,
    _render_outstanding_commitments,
)


def _offer_req(**over) -> DraftRequest:
    base = dict(
        purpose="counter_offer",
        creatorName="Robin",
        proposedTerms={"rate": 250},
        round=1,
    )
    base.update(over)
    return DraftRequest(**base)


# ---------------------------------------------------------------------------
# Draft (offer) prompt
# ---------------------------------------------------------------------------


def test_offer_prompt_renders_commitments_block_when_present():
    req = _offer_req(openCommitments=["confirm the usage rights", "check shipping timeline"])
    prompt = _build_offer_prompt(req, sender="Pluvus", ctx={})
    assert "OUTSTANDING COMMITMENTS" in prompt
    assert "confirm the usage rights" in prompt
    assert "check shipping timeline" in prompt


def test_offer_prompt_omits_commitments_block_when_empty():
    # Default (no commitments) → the block must be absent, so the copy is unchanged
    # for every existing caller.
    with_none = _build_offer_prompt(_offer_req(), sender="Pluvus", ctx={})
    assert "OUTSTANDING COMMITMENTS" not in with_none


def test_offer_prompt_commitment_block_is_additive_only():
    # The ONLY difference between the no-commitment prompt and the with-commitment
    # prompt is the added block — nothing else in the prompt changes.
    base = _build_offer_prompt(_offer_req(), sender="Pluvus", ctx={})
    withc = _build_offer_prompt(
        _offer_req(openCommitments=["confirm the usage rights"]), sender="Pluvus", ctx={}
    )
    # Removing the block from `withc` should recover something very close to base:
    # every non-block line in base still appears in withc.
    for line in base.splitlines():
        if line.strip():
            assert line in withc


def test_blank_commitments_are_ignored():
    req = _offer_req(openCommitments=["   ", "", "real commitment"])
    prompt = _build_offer_prompt(req, sender="Pluvus", ctx={})
    assert "real commitment" in prompt
    # A block with a single real item still renders.
    assert "OUTSTANDING COMMITMENTS" in prompt


# ---------------------------------------------------------------------------
# Negotiate prompt render helper
# ---------------------------------------------------------------------------


def test_render_outstanding_commitments_empty_is_blank():
    assert _render_outstanding_commitments([]) == ""
    assert _render_outstanding_commitments(["  ", ""]) == ""


def test_render_outstanding_commitments_data_framed():
    out = _render_outstanding_commitments(["confirm the usage rights"])
    assert "confirm the usage rights" in out
    # Framed as DATA / context, explicitly NOT a pricing input.
    assert "<outstanding_commitments>" in out
    assert "NOT a pricing input" in out


def test_negotiate_request_accepts_openCommitments_default_empty():
    req = NegotiateRequest(
        creatorReply="hi",
        currentOffer=NegotiationTerm(rate=250),
        round=1,
        maxRounds=3,
        campaignConstraints=CampaignConstraints(
            termFloor=NegotiationTerm(rate=200),
            termCeiling=NegotiationTerm(rate=500),
        ),
    )
    assert req.openCommitments == []
