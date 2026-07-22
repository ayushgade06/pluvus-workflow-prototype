"""Replay each sample conversation against BOTH copy paths and capture the
COMPLETE, verbatim response at every stage.

Two passes per conversation:
  * AI pass          — the REAL agent endpoints (/classify, /negotiate, /draft).
                       The LLM writes the copy and (strategy=llm) makes the
                       decision. This is the AI column.
  * Deterministic    — the Python port of MockNegotiationProvider (no LLM, no
    (template) pass     network): rule-based negotiate + fixed template draft.
                       This is the non-AI column.

Each pass is an INDEPENDENT replay, because the two paths make different
decisions and therefore diverge in round/state (e.g. the AI accepts on turn 1
where the mock counters). We replay each with its own state machine (mirroring
the TS negotiation executor) and the emitter pairs them up per conversation.

Per turn we store the FULL response dict from each endpoint (not a summary), so
the artifact can show the complete /classify, /negotiate, and /draft output
verbatim — exactly what the founder asked for.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from samples.campaign import (
    CAMPAIGN,
    CREATOR_NAME,
    CREATOR_NICHE,
    CREATOR_PLATFORM,
    Campaign,
)
from samples.client import AgentClient
from samples.conversations import Conversation, Turn
from samples.deterministic import DeterministicProvider


# ---------------------------------------------------------------------------
# Captured results (consumed by the markdown emitter). We keep the FULL raw
# response dicts so the artifact shows complete verbatim output.
# ---------------------------------------------------------------------------


@dataclass
class TurnResult:
    round_in: int
    creator_message: str
    expect: str
    # Full raw endpoint responses (None when a stage didn't run this turn).
    classify_raw: dict[str, Any] | None = None
    classify_is_ai: bool = False
    negotiate_raw: dict[str, Any] | None = None
    draft_purpose: str | None = None
    draft_raw: dict[str, Any] | None = None
    terminal_state: str | None = None  # ACCEPTED / REJECTED / MANUAL_REVIEW / None
    close_email_body: str | None = None  # deterministic close, on max-rounds reject
    notes: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class PassResult:
    """One full replay of a conversation under one provider."""

    label: str  # "AI" or "Deterministic (template)"
    turns: list[TurnResult] = field(default_factory=list)


@dataclass
class ConversationResult:
    conversation: Conversation
    ai: PassResult
    deterministic: PassResult


# ---------------------------------------------------------------------------
# Provider protocol — the two copy paths behind one interface
# ---------------------------------------------------------------------------


class Provider(Protocol):
    label: str
    has_classify: bool

    def classify(self, message: str) -> dict[str, Any] | None: ...
    def negotiate(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def draft(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def draft_context(self, campaign: Campaign) -> dict[str, Any]: ...


class AgentProvider:
    """AI path — the real endpoints. Copy + (strategy=llm) decision from the LLM."""

    label = "AI"
    has_classify = True

    def __init__(self, client: AgentClient) -> None:
        self.client = client

    def classify(self, message: str) -> dict[str, Any] | None:
        return self.client.classify(message)

    def negotiate(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.client.negotiate(payload)

    def draft(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.client.draft(payload)

    def draft_context(self, campaign: Campaign) -> dict[str, Any]:
        # Band-free — the AI copy must never see minBudget/maxBudget.
        return campaign.draft_campaign_context()


class TemplateProvider:
    """Deterministic path — the mock port. No LLM, no network. No classifier
    (the mock has none), so classify() returns None and the artifact notes that
    classification is an AI-only stage."""

    label = "Deterministic (template)"
    has_classify = False

    def __init__(self) -> None:
        self._det = DeterministicProvider()

    def classify(self, message: str) -> dict[str, Any] | None:
        return None  # mock has no classifier

    def negotiate(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._det.negotiate(payload)

    def draft(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._det.draft(payload)

    def draft_context(self, campaign: Campaign) -> dict[str, Any]:
        # The mock template copy DOES cite the band range.
        return campaign.mock_campaign_context()


# ---------------------------------------------------------------------------
# Executor-mirroring helpers
# ---------------------------------------------------------------------------

_MAX_FREE_PRESENT_OFFERS = 3  # negotiation.ts MAX_FREE_PRESENT_OFFERS


def _classify_is_ai(resp: dict[str, Any]) -> bool:
    """Did the LLM classify this, or did a deterministic gate short-circuit?

    classify.py returns a fixed reasoning string for each deterministic gate
    (opt-out / injection / topic / rate / question). Detect those by signature so
    the artifact can tag classify AI vs deterministic-gate per turn."""
    reasoning = (resp.get("reasoning") or "").lower()
    deterministic_markers = (
        "deterministic opt-out",
        "possible prompt-injection",
        "always-escalate topic",
        "deterministic rate-statement",
        "deterministic question-phrase",
    )
    return not any(m in reasoning for m in deterministic_markers)


def _rate_of(neg: dict[str, Any]) -> float | None:
    terms = neg.get("proposedTerms")
    if isinstance(terms, dict) and isinstance(terms.get("rate"), (int, float)):
        return float(terms["rate"])
    return None


def _action_to_outcome(action: str) -> str:
    return {
        "ACCEPT": "accept",
        "COUNTER": "counter",
        "PRESENT_OFFER": "present_offer",
        "REJECT": "reject",
        "ESCALATE": "escalate",
    }.get((action or "").upper(), "escalate")


# ---------------------------------------------------------------------------
# The replay
# ---------------------------------------------------------------------------


class ConversationRunner:
    def __init__(
        self,
        agent_client: AgentClient,
        campaign: Campaign = CAMPAIGN,
    ) -> None:
        self.agent = AgentProvider(agent_client)
        self.template = TemplateProvider()
        self.campaign = campaign

    def run(self, conv: Conversation, *, run_ai: bool = True, run_template: bool = True) -> ConversationResult:
        ai = PassResult(label=self.agent.label)
        det = PassResult(label=self.template.label)
        if run_ai:
            ai = self._replay(conv, self.agent)
        if run_template:
            det = self._replay(conv, self.template)
        return ConversationResult(conversation=conv, ai=ai, deterministic=det)

    def _draft_base(self, provider: Provider, purpose: str) -> dict[str, Any]:
        c = self.campaign
        base = {
            "purpose": purpose,
            "creatorName": CREATOR_NAME,
            "creatorPlatform": CREATOR_PLATFORM,
            "creatorNiche": CREATOR_NICHE,
            "senderName": c.sender_name,
            "brandDescription": c.brand_description,
            "campaignContext": provider.draft_context(c),
            "dealDescription": c.deal_description(),
            "deliverables": c.deliverables,
            "timeline": c.timeline,
            "rewardDescription": c.reward_description,
            # knowledge fields as explicit DraftRequest fields (agent reads these
            # first, then campaignContext).
            "usageRights": c.usage_rights,
            "exclusivity": c.exclusivity,
            "paymentTerms": c.payment_terms,
            "attributionWindow": c.attribution_window,
        }
        return base

    def _replay(self, conv: Conversation, provider: Provider) -> PassResult:
        c = self.campaign
        res = PassResult(label=provider.label)

        round_num = 0
        prior_offer: float | None = None
        negotiation_history: list[dict[str, Any]] = []
        conversation_history: list[dict[str, Any]] = []
        trailing_presents = 0

        for turn in conv.turns:
            tr = TurnResult(round_in=round_num, creator_message=turn.creator_message, expect=turn.expect)
            try:
                self._run_turn(
                    provider,
                    turn,
                    tr,
                    round_num=round_num,
                    prior_offer=prior_offer,
                    negotiation_history=negotiation_history,
                    conversation_history=conversation_history,
                    trailing_presents=trailing_presents,
                )
            except Exception as exc:
                tr.error = f"{type(exc).__name__}: {exc}"
                res.turns.append(tr)
                break

            res.turns.append(tr)

            # Advance threaded state from this turn's outcome.
            neg = tr.negotiate_raw or {}
            action = (neg.get("action") or "").upper()
            outcome = _action_to_outcome(action)
            rate = _rate_of(neg)
            sent_body = (tr.draft_raw or {}).get("body") if tr.draft_raw else None

            conversation_history.append({"role": "creator", "message": turn.creator_message})

            # OPT_OUT / injection at classify with no negotiate → terminal.
            if tr.terminal_state in ("OPT_OUT", "MANUAL_REVIEW", "REJECTED", "ACCEPTED") and tr.negotiate_raw is None:
                break

            if outcome in ("accept", "reject", "escalate"):
                if sent_body:
                    conversation_history.append(
                        {"role": "us", "action": action, "rate": rate, "message": sent_body}
                    )
                break

            if outcome == "present_offer":
                trailing_presents += 1
                if trailing_presents > _MAX_FREE_PRESENT_OFFERS:
                    round_num += 1
                if rate is not None:
                    prior_offer = rate
                negotiation_history.append(
                    {"round": round_num, "action": "PRESENT_OFFER", "terms": {"rate": rate}, "message": sent_body}
                )
                if sent_body:
                    conversation_history.append(
                        {"role": "us", "action": "PRESENT_OFFER", "rate": rate, "message": sent_body}
                    )
            elif outcome == "counter":
                trailing_presents = 0
                round_num += 1
                if rate is not None:
                    prior_offer = rate
                negotiation_history.append(
                    {"round": round_num, "action": "COUNTER", "terms": {"rate": rate}, "message": sent_body}
                )
                if sent_body:
                    conversation_history.append(
                        {"role": "us", "action": "COUNTER", "rate": rate, "message": sent_body}
                    )

        return res

    def _run_turn(
        self,
        provider: Provider,
        turn: Turn,
        tr: TurnResult,
        *,
        round_num: int,
        prior_offer: float | None,
        negotiation_history: list[dict[str, Any]],
        conversation_history: list[dict[str, Any]],
        trailing_presents: int,
    ) -> None:
        c = self.campaign

        # 1) classify — only the first turn (round 0), and only for providers with
        # a classifier (the AI path). Mid-negotiation replies skip classify.
        if round_num == 0 and provider.has_classify:
            tr.classify_raw = provider.classify(turn.creator_message)
            if tr.classify_raw is not None:
                tr.classify_is_ai = _classify_is_ai(tr.classify_raw)
                # A hard OPT_OUT at classify terminates without negotiating.
                if (tr.classify_raw.get("intent") or "").upper() == "OPT_OUT":
                    tr.terminal_state = "OPT_OUT"
                    tr.notes.append(
                        "Deterministic OPT_OUT at /classify (compliance) — no /negotiate, no email."
                    )
                    return

        # 2) negotiate.
        current_offer_rate = prior_offer if prior_offer is not None else c.min_budget
        neg_payload: dict[str, Any] = {
            "creatorReply": turn.creator_message,
            "currentOffer": {"rate": current_offer_rate},
            "round": round_num,
            "maxRounds": c.max_rounds,
            "negotiationHistory": negotiation_history,
            "campaignConstraints": c.campaign_constraints(),
        }
        if conversation_history:
            neg_payload["conversationHistory"] = conversation_history
        tr.negotiate_raw = provider.negotiate(neg_payload)

        neg = tr.negotiate_raw
        action = (neg.get("action") or "").upper()
        outcome = _action_to_outcome(action)
        rate = _rate_of(neg)
        creator_questions = neg.get("creatorQuestions") or []
        pushed = neg.get("pushedFixedTerms") or []
        creator_requested = neg.get("creatorRequestedRate")
        is_final_round = bool(neg.get("isFinalRound"))

        # 3) terminal outcomes — no email drafted.
        if outcome == "reject":
            tr.terminal_state = "REJECTED"
            tr.notes.append("REJECTED — conversation closed (no email drafted here).")
            return
        if outcome == "escalate":
            tr.terminal_state = "MANUAL_REVIEW"
            reason = neg.get("escalationReason") or "escalated"
            tr.notes.append(f"ESCALATED (reason: {reason}) — routed to a human, no email sent.")
            return

        # Secondary max-rounds guard on the counter path → deterministic close.
        if outcome == "counter" and c.max_rounds > 0 and (round_num + 1) >= c.max_rounds:
            tr.terminal_state = "REJECTED"
            tr.close_email_body = _render_close(self.campaign)
            tr.notes.append(
                "Counter would hit maxRounds — executor auto-closes with the deterministic "
                "max-rounds close email, then REJECTED."
            )
            return

        # 4) draft the SENT email.
        if outcome == "accept":
            purpose = "onboarding" if rate is not None else "acceptance"
            tr.terminal_state = "ACCEPTED"
        else:  # present_offer | counter → counter_offer
            purpose = "counter_offer"

        draft_payload = self._draft_base(provider, purpose)
        if rate is not None:
            draft_payload["proposedTerms"] = {"rate": rate}
        draft_payload["creatorReply"] = turn.creator_message
        if isinstance(creator_requested, (int, float)):
            draft_payload["creatorRequestedRate"] = creator_requested
        if creator_questions:
            draft_payload["creatorQuestions"] = creator_questions
        if pushed:
            draft_payload["pushedFixedTerms"] = pushed
        if conversation_history:
            draft_payload["history"] = conversation_history
        if outcome == "counter":
            draft_payload["round"] = round_num + 1
            if is_final_round:
                draft_payload["isFinalRound"] = True

        tr.draft_purpose = purpose
        tr.draft_raw = provider.draft(draft_payload)

        if outcome == "present_offer":
            tr.notes.append("PRESENT_OFFER — informational; does not consume a negotiation round.")
        elif outcome == "counter" and is_final_round:
            tr.notes.append("Final round — the offer email states finality (best-and-final).")


def _render_close(campaign: Campaign) -> str:
    from samples import templates

    return templates.render(
        templates.MAX_ROUNDS_CLOSE_BODY,
        creator_name=CREATOR_NAME,
        brand_name=campaign.brand_name,
        sender_name=campaign.sender_name,
    )
