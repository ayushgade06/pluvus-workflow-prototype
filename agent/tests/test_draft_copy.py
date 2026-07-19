"""Unit tests for draft-copy hardening (brand leak + currency drift).

Covers the pure helpers behind three reported bugs:
  * `_format_rate` — fixed-currency USD rendering so the model can't drift $→£.
  * `_scrub_brand` — maps a stray "Pluvus" the model emits back to the real
    campaign sender (e.g. Barclays), and fills bracketed placeholders.

Pure functions, no LLM / no network.
"""

import pytest

from app.routes.negotiate import (
    DraftRequest,
    _format_rate,
    _scrub_brand,
    _template_draft_fallback,
)


# ---------------------------------------------------------------------------
# _format_rate — always "$", integers without trailing .0
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        (350, "$350"),
        (350.0, "$350"),
        (480.5, "$480.5"),
        ("480", "$480"),
        ("$480", "$480"),
        ("1,500", "$1500"),
        (None, None),
        ("", None),
        ("abc", None),
        (True, None),  # bool must not render as $1
    ],
)
def test_format_rate(raw, expected):
    assert _format_rate(raw) == expected


# ---------------------------------------------------------------------------
# _scrub_brand — stray Pluvus → real sender (when sender isn't Pluvus)
# ---------------------------------------------------------------------------


def test_scrub_maps_stray_pluvus_to_sender():
    body = "Thanks for partnering with Pluvus! Best, Pluvus"
    out = _scrub_brand(body, "Barclays")
    assert "Pluvus" not in out
    assert out.count("Barclays") == 2


def test_scrub_maps_pluvus_partnerships_phrase():
    body = "We at Pluvus Partnerships are excited."
    out = _scrub_brand(body, "Barclays")
    assert "Pluvus" not in out
    assert "Barclays" in out


def test_scrub_leaves_pluvus_when_sender_is_pluvus():
    """When the campaign brand genuinely IS Pluvus, don't mangle it."""
    body = "Welcome to Pluvus!"
    out = _scrub_brand(body, "Pluvus Partnerships")
    assert "Pluvus" in out


def test_scrub_fills_bracketed_placeholders():
    body = "Hi, [Name] here from [Brand]. Best,\n[Your Name]"
    out = _scrub_brand(body, "Barclays")
    assert "[Name]" not in out
    assert "[Brand]" not in out
    assert "[Your Name]" not in out
    assert "Barclays" in out


def test_scrub_does_not_touch_unrelated_text():
    body = "We loved your fitness content, Alex. Best, Barclays"
    out = _scrub_brand(body, "Barclays")
    assert out == body


# ---------------------------------------------------------------------------
# L3 — the placeholder sweep catches the variants the explicit list missed,
# without eating legitimate bracketed content.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "placeholder",
    ["<Name>", "[Company]", "[Sender]", "[Signature]", "[previous creator's name]", "[Your Company]"],
)
def test_scrub_catches_additional_placeholders(placeholder):
    body = f"Hi there, this is {placeholder} reaching out."
    out = _scrub_brand(body, "Barclays")
    assert placeholder not in out
    assert "Barclays" in out


def test_scrub_preserves_legitimate_bracket_content():
    # Non-placeholder bracket content must survive: emoticons, money, URLs,
    # handles with digits/symbols. These are not name/label-shaped tokens.
    for keep in ["<3", "[$500]", "<https://acme.com>", "[10% off]", "<@user_42>"]:
        body = f"Check this out {keep} — from Barclays"
        out = _scrub_brand(body, "Barclays")
        assert keep in out, f"scrub wrongly removed {keep!r}: {out!r}"


def test_scrub_preserves_lowercase_instruction_copy():
    # EASY-P6: legit lowercase bracketed COPY (an instruction/CTA phrase, no
    # placeholder keyword) must survive — it is not a name/label to fill.
    for keep in ["[link to media kit]", "[click here]", "[insert here]", "[see below]"]:
        body = f"Grab the details {keep} and reply — Barclays"
        out = _scrub_brand(body, "Barclays")
        assert keep in out, f"scrub wrongly rewrote copy {keep!r}: {out!r}"
        assert "Barclays" in out


def test_scrub_multiple_placeholders_in_one_body():
    body = "Hi [Name], <Signature> here at [Company]. Best,\n[Your Name]"
    out = _scrub_brand(body, "Barclays")
    assert "[" not in out and "<" not in out
    assert "Barclays" in out


# ---------------------------------------------------------------------------
# F-D5 — the deterministic template fallback for a draft that fails structured
# output. Model-free; states the fee + fixed-term ack + known facts, never invents.
# ---------------------------------------------------------------------------


def _draft_req(**kw):
    base = dict(
        purpose="counter_offer",
        creatorName="Jordan",
        senderName="AeroSoft",
        proposedTerms={"rate": 400},
    )
    base.update(kw)
    return DraftRequest(**base)


def test_template_fallback_states_fee_and_signs_off():
    resp = _template_draft_fallback(_draft_req(), "AeroSoft", {}, {})
    assert resp is not None
    assert "$400" in resp.body
    assert "AeroSoft" in resp.body
    assert resp.subject


def test_template_fallback_acknowledges_pushed_perk_as_fixed():
    # D5 shape: creator asked for a second pair; pushedFixedTerms=["perk"].
    resp = _template_draft_fallback(
        _draft_req(pushedFixedTerms=["perk"], creatorQuestions=["Can I get two pairs?"]),
        "AeroSoft", {}, {},
    )
    assert resp is not None
    assert "perk" in resp.body.lower()
    assert "fixed" in resp.body.lower()


def test_template_fallback_states_known_fact_when_asked():
    known = {"Payment terms / schedule": "Net-30 after the content goes live."}
    resp = _template_draft_fallback(
        _draft_req(creatorQuestions=["When do I get paid?"]),
        "AeroSoft", {"paymentTerms": "Net-30 after the content goes live."}, known,
    )
    assert resp is not None
    assert "Net-30" in resp.body


def test_template_fallback_acknowledges_creator_ask():
    resp = _template_draft_fallback(
        _draft_req(creatorRequestedRate=460), "AeroSoft", {}, {}
    )
    assert resp is not None
    assert "$460" in resp.body  # acknowledged
    assert "$400" in resp.body  # our offer


def test_template_fallback_returns_none_without_a_rate():
    # No number to state on a money turn → cannot template; caller re-raises.
    resp = _template_draft_fallback(
        _draft_req(proposedTerms=None), "AeroSoft", {}, {}
    )
    assert resp is None


def test_template_fallback_returns_none_for_non_offer_purpose():
    resp = _template_draft_fallback(
        _draft_req(purpose="follow_up"), "AeroSoft", {}, {}
    )
    assert resp is None


def test_template_fallback_never_leaks_a_bound():
    # Only the guarded offer figure appears — no floor/ceiling is available to the
    # template (it isn't passed any), so it structurally cannot leak one.
    resp = _template_draft_fallback(_draft_req(proposedTerms={"rate": 400}), "AeroSoft", {}, {})
    assert resp is not None
    assert "200" not in resp.body and "500" not in resp.body


def test_end_to_end_draft_falls_back_to_template_on_structured_error(monkeypatch):
    # Force the draft model to fail JSON output; the offer turn must ship the
    # template fallback rather than raising (which would escalate).
    from app.routes import negotiate as neg
    from app.structured import StructuredOutputError

    def _boom(*_a, **_k):
        raise StructuredOutputError("model kept emitting prose", raw="not json")

    monkeypatch.setattr(neg, "invoke_structured", _boom)
    monkeypatch.setattr(neg, "get_llm", lambda *a, **k: object())
    resp = neg._langgraph_draft(_draft_req(creatorQuestions=["Can I get two pairs?"], pushedFixedTerms=["perk"]))
    assert "$400" in resp.body
    assert "perk" in resp.body.lower()
