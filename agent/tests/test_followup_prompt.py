"""Tests for the dedicated follow-up draft prompt (H3).

Regression target: `follow_up` used to fall through to the initial-outreach
prompt (`_DRAFT_PROMPT`), which MANDATES a full product-intro paragraph — so every
follow-up re-pitched the brand from scratch and read as a duplicate cold email.
There is now a dedicated `_FOLLOWUP_PROMPT` framing a brief, low-pressure nudge.

Uses a prompt-capturing fake LLM (no real model / Ollama needed).
"""

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app.routes import negotiate as neg_mod
from app.routes.negotiate import DraftRequest


class CapturingLLM:
    """Fake LLM that records the prompt it was asked and returns fixed JSON."""

    def __init__(self):
        self.prompt = None

    def invoke(self, prompt):
        self.prompt = prompt

        class _R:
            content = '{"subject": "Circling back", "body": "Hi Alex,\\n\\nJust following up.\\n\\nBest,\\nAcme"}'

        return _R()


def _run(monkeypatch, req: DraftRequest) -> str:
    cap = CapturingLLM()
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0.7: cap)
    neg_mod._langgraph_draft(req)
    return cap.prompt


def _followup_req(**kw) -> DraftRequest:
    base = dict(
        purpose="follow_up",
        creatorName="Alex",
        creatorPlatform="Instagram",
        creatorNiche="fitness",
        senderName="Acme",
        brandDescription="Acme makes recovery supplements.",
        round=1,
    )
    base.update(kw)
    return DraftRequest(**base)


def test_followup_uses_the_dedicated_nudge_prompt(monkeypatch):
    prompt = _run(monkeypatch, _followup_req())
    # It must be framed as a follow-up reminder, not a fresh pitch.
    assert "FOLLOW-UP" in prompt
    assert "have NOT heard back" in prompt
    # And explicitly instructed NOT to re-introduce the product in full.
    assert "Do NOT re-introduce" in prompt


def test_followup_prompt_is_not_the_cold_outreach_prompt(monkeypatch):
    prompt = _run(monkeypatch, _followup_req())
    # The initial-outreach prompt mandates a dedicated PRODUCT PARAGRAPH; the
    # follow-up prompt must NOT (that's the whole bug being fixed).
    assert "DEDICATED short paragraph" not in prompt
    assert "PRODUCT PARAGRAPH" not in prompt


def test_followup_prompt_forbids_money_and_placeholders(monkeypatch):
    prompt = _run(monkeypatch, _followup_req())
    assert "Do NOT state any dollar amount" in prompt
    assert "bracketed placeholder" in prompt
    # Signs as the real sender, never Pluvus.
    assert "Acme" in prompt


def test_followup_still_returns_a_valid_draft(monkeypatch):
    cap = CapturingLLM()
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0.7: cap)
    out = neg_mod._langgraph_draft(_followup_req())
    assert out.subject and out.body
    assert "following up" in out.body.lower()
