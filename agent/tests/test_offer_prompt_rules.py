"""Regression tests for counter/offer email prompt rules.

The counter-offer email is LLM-generated, so we can't assert the final copy
deterministically. Instead we assert the PROMPT carries the guardrails that were
added after two reported issues:

  * "as agreed" — a counter-offer must NOT imply the terms are already settled
    (the creator asked for $500; we countered at $425 — nothing is agreed yet).
  * "reply with your preferred time" — the go-live timeline is the brand's fixed
    value; the email must state it and must NOT ask the creator for their timing.

Pure string checks on the built prompt; no LLM / no network.
"""

from app.routes.negotiate import (
    DraftRequest,
    _build_offer_prompt,
    _deal_label_without_commission,
    _scope_lines,
)

# The server-built hybrid deal description (mirrors describeDeal in the Node
# engine): a deal-type label followed by the commission clause. Threaded into the
# offer prompt as dealDescription so the tests exercise the real dedup path.
_HYBRID_DEAL = (
    "a hybrid partnership — you receive a fixed fee for your content, PLUS a 10% "
    "commission on the sales you drive. (The exact fee is discussed once you reply.)"
)


def _prompt(**overrides) -> str:
    req = DraftRequest(
        purpose="counter_offer",
        creatorName="Ayush",
        proposedTerms={"rate": 425},
        dealDescription=_HYBRID_DEAL,
        deliverables="2 Instagram Reels + 1 Instagram Story",
        timeline="Content live by July 20, 2026",
        **overrides,
    )
    ctx = {
        "commissionRate": 10,
        "deliverables": "2 Instagram Reels + 1 Instagram Story",
        "timeline": "Content live by July 20, 2026",
    }
    # Build scope lines exactly as _langgraph_draft does in production, so the
    # brand deliverables/timeline are threaded into the prompt.
    scope = _scope_lines(req, ctx)
    return _build_offer_prompt(req, "Pluvus", ctx, "", scope)


def test_offer_prompt_forbids_agreed_language():
    p = _prompt()
    # The rule explicitly names the forbidden phrases and frames it as an OFFER.
    assert "NOT a closed deal" in p
    assert "as agreed" in p  # named in the ban list
    assert 'imply the fee/terms are already settled'.split()[0] in p  # "NEVER write ..."


def test_offer_prompt_treats_timeline_as_fixed_and_forbids_asking_for_time():
    p = _prompt()
    assert "preferred timing" in p or "preferred time" in p
    # Timeline is stated as fixed and on its own bullet.
    assert "fixed" in p.lower()
    assert "own" in p.lower() and "bullet" in p.lower()
    # The brand's exact timeline value is threaded in.
    assert "Content live by July 20, 2026" in p


def test_cta_asks_to_confirm_not_schedule():
    p = _prompt()
    # The call-to-action must be about confirming the offer, not scheduling.
    assert "confirm the offer" in p or "confirm the\noffer" in p
    assert "schedule a call" in p  # named as something NOT to do


# ── Fix: commission is stated ONCE (was duplicated: numbered point + bullet + ──
#    deal-structure line, so the 7B model emitted two near-identical lines) ─────


def test_commission_percentage_not_repeated_as_content():
    """The commission % must appear as email CONTENT in exactly one place — the
    dedicated bullet. The old prompt injected it three ways (a numbered
    'Commission' point, the bullet hint, AND the full deal-structure sentence),
    which made the model write the commission twice. We assert it isn't over-
    injected: the numbered 'Commission' point is gone, the deal-structure line
    carries the deal LABEL only (no percentage), and the bullet says it once.
    """
    p = _prompt()
    # No standalone numbered "Commission" instruction any more.
    assert "Commission —" not in p and "Commission -" not in p
    # The commission bullet exists and is explicitly single-shot.
    assert "10% commission" in p
    assert "state the percentage here and only here" in p
    # The deal-structure point must NOT carry the percentage (it's the duplicate
    # source): the "10%" must not sit on the "Deal structure" line.
    deal_line = next(ln for ln in p.splitlines() if "Deal structure" in ln)
    assert "10%" not in deal_line
    assert "Do NOT state the commission percentage here" in deal_line


def test_deal_label_strips_commission_clause():
    """The deal-type label fed into the deal-structure point drops the commission
    clause, so the percentage lives only on the commission bullet."""
    assert _deal_label_without_commission(_HYBRID_DEAL) == "a hybrid partnership"
    # A hyphen-separated variant (server may emit "-" instead of an em dash).
    assert (
        _deal_label_without_commission("a fixed-fee collaboration - a flat fee.")
        == "a fixed-fee collaboration"
    )
    # No separator → falls back without raising, splitting off a PLUS clause.
    assert (
        _deal_label_without_commission("affiliate deal PLUS a 15% commission")
        == "affiliate deal"
    )


def test_fixed_fee_deal_has_no_commission_bullet():
    """A fixed-fee deal (no commission in ctx) must not present any commission %
    as a deal term, and must use the full deal description (nothing to strip).

    NOTE: the prompt now carries an explicit guard TELLING the model there is no
    commission (so it can't echo a percentage the creator names), so the literal
    word "commission" DOES appear — in a negative instruction. We therefore assert
    the absence of any commission BULLET / percentage-as-content, not the absence
    of the word."""
    req = DraftRequest(
        purpose="counter_offer",
        creatorName="Ayush",
        proposedTerms={"rate": 425},
        dealDescription="a fixed-fee collaboration — a flat fee for agreed content.",
        deliverables="1 Reel",
        timeline="Live by July 20, 2026",
    )
    ctx = {"deliverables": "1 Reel", "timeline": "Live by July 20, 2026"}
    p = _build_offer_prompt(req, "Pluvus", ctx, "", _scope_lines(req, ctx))
    # No commission percentage presented as CONTENT (a numeric N% figure), and no
    # dedicated bullet. The static prompt now mentions "commission %" in a negative
    # instruction (no number attached), so assert the absence of a numeric percent,
    # not a bare "%".
    import re as _re
    assert not _re.search(r"\d+(?:\.\d+)?\s*%", p)
    assert "commission bullet" not in p.lower()
    # The guard is present and negative — it forbids mentioning/agreeing to one.
    assert "NO commission component" in p
    assert "agree to any commission percentage" in p


def test_offer_prompt_pins_commission_and_forbids_creator_echo():
    """Regression: the commission is the BRAND's figure, never the creator's.

    Prod leak — campaign commission was 10% but the creator's message said "keep
    the 13% commission structure the same", and the offer copy restated "13%
    commission structure". The prompt must (a) pin the campaign's own percentage
    and (b) explicitly forbid repeating/adopting any other percentage the creator
    names."""
    p = _prompt()  # ctx commissionRate = 10
    assert "it is EXACTLY 10%" in p
    # The anti-echo instruction: ignore any other percentage the creator wrote.
    collapsed = " ".join(p.split())
    assert "IGNORE their number" in collapsed
    assert "keep the same" in collapsed  # bans "keep the same" for a foreign %
    # And it must not treat the commission as the creator's to set.
    assert "never imply the commission is theirs to set" in collapsed.lower()


# ── Fix: cookie/attribution (and similar) deferral is CONDITIONAL on the ───────
#    creator actually asking — the prompt no longer volunteers these topics ─────


def test_offer_prompt_does_not_volunteer_unasked_topics():
    """The deferral instruction must be gated on the creator actually raising the
    topic, and must explicitly forbid volunteering it — the old prompt named
    'cookie/attribution window' unconditionally, so the model surfaced it even
    when nobody asked."""
    p = _prompt()
    # The conditional guard is present …
    assert "Only address topics the creator ACTUALLY raised" in p
    assert "Do NOT proactively bring up" in p
    assert "ONLY if" in p
    # … and the closing instruction to stay silent when unasked. Collapse
    # whitespace first — the template wraps this sentence across lines.
    collapsed = " ".join(p.split())
    assert "do not mention these subjects at all" in collapsed


# ── Comprehension threading (spec: draft-comprehension-threading.md §7/§9.5) ────
#    /negotiate now hands /draft an explicit question checklist + the fixed terms
#    the creator pushed, so the offer prompt fires PRECISELY instead of relying on
#    the model re-parsing the raw reply. These assert the prompt renders those
#    blocks when the fields are populated and is byte-unchanged when they are empty.


def test_question_checklist_renders_each_question_when_populated():
    """A populated creatorQuestions list becomes a numbered must-answer checklist
    in the prompt (spec §7.1), naming every question the creator raised."""
    questions = [
        "what is the fee?",
        "when does content go live?",
        "can I get 15% commission?",
    ]
    p = _prompt(creatorQuestions=questions)
    # The checklist header is unique to the rendered block (distinct from the
    # prompt's always-present generic "your email MUST answer EACH one" line).
    assert "The creator asked the following" in p
    # Every question is enumerated verbatim in the checklist.
    for i, q in enumerate(questions, start=1):
        assert f"{i}) {q}" in p


def test_question_checklist_absent_when_no_questions():
    """With no creatorQuestions the explicit checklist block does not render —
    behavior falls back to the prompt's generic 'identify EVERY question' text,
    so the prompt is unchanged from before this feature."""
    p = _prompt()  # creatorQuestions defaults to []
    assert "The creator asked the following" not in p


def test_pushed_fixed_term_acknowledgement_renders_and_names_term():
    """When the creator PUSHED a fixed term, the fixed-terms point fires and names
    the specific term(s) with their fixed value so the copy acknowledges the ask
    (the Case-10 gap), not merely restates the value (spec §7.2)."""
    p = _prompt(pushedFixedTerms=["commission", "perk"], rewardDescription="a free pair of shoes")
    collapsed = " ".join(p.split())
    # The pushed-terms point is present and framed as "the creator asked to change".
    assert "Fixed terms the creator asked to change" in collapsed
    assert "PUSHED on" in collapsed
    # The commission is named as fixed at the campaign value (10% from ctx).
    assert "the commission is fixed at 10%" in collapsed
    # The pushed perk is named with its fixed value.
    assert "the product perk is fixed as a free pair of shoes" in collapsed


def test_pushed_fixed_term_normalizes_vocabulary_synonyms():
    """pushedFixedTerms is normalized to the closed vocabulary in code (spec §4.2),
    so a synonym like 'commission rate' still fires the commission acknowledgement
    rather than being dropped."""
    p = _prompt(pushedFixedTerms=["commission rate"])
    assert "the commission is fixed at 10%" in p


def test_fixed_terms_point_absent_when_nothing_pushed():
    """The fixed-terms acknowledgement point does NOT fire merely because the
    campaign HAS fixed terms — only when the creator actually pushed one. With an
    empty pushedFixedTerms the block is absent (the standing 'only the fee is
    negotiable' rule in the prompt body still applies)."""
    p = _prompt()  # ctx has commissionRate=10 but pushedFixedTerms defaults to []
    assert "Fixed terms the creator asked to change" not in p
    assert "PUSHED on" not in p
    # The general fixed-terms rule in the prompt body is still present (unchanged).
    assert "only the fixed fee is negotiable" in p


def test_prompt_byte_identical_when_comprehension_empty():
    """Regression guard (spec §9.4/§9.5): with both comprehension fields empty the
    built prompt is IDENTICAL to one built without ever passing them — the feature
    adds nothing to the audited path when the producer emitted nothing."""
    baseline = _prompt()
    with_empty = _prompt(creatorQuestions=[], pushedFixedTerms=[])
    assert baseline == with_empty
