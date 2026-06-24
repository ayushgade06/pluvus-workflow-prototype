"""
POST /negotiate — bounded negotiation decision
POST /draft    — email copy generation

Both endpoints fall back to rule-based / template implementations when
OPENAI_API_KEY is absent, so the system runs without credentials.

Negotiation input:
  { creatorReply, currentOffer, round, maxRounds, negotiationHistory, campaignConstraints }

Negotiation output:
  { action: ACCEPT|COUNTER|REJECT|ESCALATE, proposedTerms?, responseDraft?, reasoning? }

Draft input:
  { purpose, creatorName, creatorPlatform?, creatorNiche?, senderName?, round?, proposedTerms? }

Draft output:
  { subject, body }
"""

from __future__ import annotations

import os
import json
import re
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# ---------------------------------------------------------------------------
# Shared types
# ---------------------------------------------------------------------------

NegotiationAction = Literal["ACCEPT", "COUNTER", "REJECT", "ESCALATE"]
DraftPurpose = Literal["initial_outreach", "follow_up", "counter_offer", "acceptance"]


class NegotiationTerm(BaseModel):
    rate: float | None = None
    deliverables: list[str] | None = None
    timeline: str | None = None


class NegotiationHistoryEntry(BaseModel):
    round: int
    action: NegotiationAction
    terms: NegotiationTerm | None = None
    message: str | None = None


class CampaignConstraints(BaseModel):
    termFloor: NegotiationTerm
    termCeiling: NegotiationTerm
    tone: str | None = None


class NegotiateRequest(BaseModel):
    creatorReply: str
    currentOffer: NegotiationTerm
    round: int
    maxRounds: int
    negotiationHistory: list[NegotiationHistoryEntry] = []
    campaignConstraints: CampaignConstraints


class NegotiateResponse(BaseModel):
    action: NegotiationAction
    proposedTerms: dict[str, Any] | None = None
    responseDraft: str | None = None
    reasoning: str | None = None


class DraftRequest(BaseModel):
    purpose: DraftPurpose
    creatorName: str
    creatorPlatform: str | None = None
    creatorNiche: str | None = None
    senderName: str | None = None
    round: int | None = None
    proposedTerms: dict[str, Any] | None = None
    campaignContext: dict[str, Any] | None = None


class DraftResponse(BaseModel):
    subject: str
    body: str


# ---------------------------------------------------------------------------
# Rule-based mock negotiation
# ---------------------------------------------------------------------------

def _extract_rate(text: str) -> float | None:
    m = re.search(r"\$\s*([\d,]+)", text)
    if m:
        return float(m.group(1).replace(",", ""))
    return None


def _mock_negotiate(req: NegotiateRequest) -> NegotiateResponse:
    if req.round >= req.maxRounds:
        return NegotiateResponse(
            action="REJECT",
            reasoning=f"Max rounds ({req.maxRounds}) reached",
        )

    ceiling = req.campaignConstraints.termCeiling.rate
    creator_rate = _extract_rate(req.creatorReply)

    if creator_rate is not None and ceiling is not None and creator_rate > ceiling:
        return NegotiateResponse(
            action="ESCALATE",
            reasoning=f"Creator demands ${creator_rate:.0f} which exceeds ceiling ${ceiling:.0f}",
            proposedTerms=req.currentOffer.model_dump(exclude_none=True),
        )

    floor_rate = req.campaignConstraints.termFloor.rate or 1000
    if req.round == 0:
        return NegotiateResponse(
            action="COUNTER",
            proposedTerms={"rate": floor_rate + 100},
            responseDraft=(
                f"Thank you for your interest! We'd like to propose a rate of "
                f"${floor_rate + 100:.0f} for this collaboration. "
                f"Here's our counter-offer for round {req.round + 1}."
            ),
            reasoning="Opening counter-offer",
        )

    return NegotiateResponse(
        action="ACCEPT",
        proposedTerms=req.currentOffer.model_dump(exclude_none=True),
        responseDraft=(
            "We're pleased to confirm the collaboration terms. "
            "Welcome aboard! Our team will follow up with the formal agreement."
        ),
        reasoning="Terms are acceptable",
    )


def _mock_draft(req: DraftRequest) -> DraftResponse:
    name = req.creatorName
    platform = req.creatorPlatform or "social media"
    sender = req.senderName or "Pluvus Partnerships"

    if req.purpose == "initial_outreach":
        return DraftResponse(
            subject=f"Collaboration opportunity — {name}",
            body=(
                f"Hi {name},\n\n"
                f"We've been following your {platform} content and think you'd be a "
                f"perfect fit for our upcoming campaign.\n\n"
                f"{sender} works with top creators in your space, and we believe this "
                f"partnership could be mutually beneficial.\n\n"
                f"Would you be open to a quick conversation about the details?\n\n"
                f"Best,\n{sender}"
            ),
        )
    elif req.purpose == "follow_up":
        n = req.round or 1
        suffix = f" (follow-up #{n})" if n > 1 else ""
        return DraftResponse(
            subject=f"Re: Collaboration opportunity — {name}",
            body=(
                f"Hi {name},\n\n"
                f"Just following up on my previous message{suffix} — "
                f"still very interested in collaborating!\n\n"
                f"We'd love to hear from you when you have a moment.\n\n"
                f"Best,\n{sender}"
            ),
        )
    elif req.purpose == "counter_offer":
        rate = (req.proposedTerms or {}).get("rate")
        rate_str = f"${rate:.0f}" if rate is not None else "our revised offer"
        return DraftResponse(
            subject="Re: Partnership proposal — updated offer",
            body=(
                f"Hi {name},\n\n"
                f"Thank you for your response. After reviewing your feedback, "
                f"we'd like to propose {rate_str} for this collaboration.\n\n"
                f"Please let us know if these terms work for you.\n\n"
                f"Best,\n{sender}"
            ),
        )
    else:  # acceptance
        return DraftResponse(
            subject="Partnership confirmed — welcome to the campaign!",
            body=(
                f"Hi {name},\n\n"
                f"Wonderful news — we're thrilled to confirm your participation!\n\n"
                f"Our team will be in touch shortly with the formal agreement and next steps.\n\n"
                f"Welcome aboard!\n\nBest,\n{sender}"
            ),
        )


# ---------------------------------------------------------------------------
# LangGraph negotiation
# ---------------------------------------------------------------------------

_NEGOTIATE_PROMPT = """\
You are a negotiation agent for an influencer outreach platform.

Campaign constraints:
- Term floor: {floor}
- Term ceiling: {ceiling}
- Tone: {tone}

Current negotiation state:
- Round: {round} of {max_rounds}
- Current offer: {current_offer}
- Creator's reply: "{creator_reply}"
- History: {history}

Decide the next action. Rules:
1. If round >= max_rounds, action MUST be REJECT or ESCALATE.
2. If creator demands above the ceiling, action MUST be ESCALATE.
3. If terms are acceptable (within floor-ceiling), prefer ACCEPT.
4. Otherwise, COUNTER with adjusted terms.

Respond ONLY with valid JSON matching this exact shape:
{{"action": "ACCEPT"|"COUNTER"|"REJECT"|"ESCALATE",
  "proposedTerms": {{"rate": <number>}} or null,
  "responseDraft": "<email body text>" or null,
  "reasoning": "<one sentence>"}}
"""

_DRAFT_PROMPT = """\
You are an email copywriter for an influencer outreach platform.

Write a {purpose} email for creator {name} ({platform}, {niche}).
Sender: {sender}
{extra}

Requirements:
- Warm, professional tone
- Concise (under 150 words)
- No placeholders — fill all details

Respond ONLY with valid JSON:
{{"subject": "<subject line>", "body": "<email body>"}}
"""


def _try_langgraph_negotiate(req: NegotiateRequest) -> NegotiateResponse | None:
    try:
        from langchain_openai import ChatOpenAI  # type: ignore[import]
        from langgraph.graph import StateGraph, END  # type: ignore[import]
    except ImportError:
        return None

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None

    try:
        llm = ChatOpenAI(model="gpt-4o-mini", temperature=0.2, api_key=api_key)

        prompt = _NEGOTIATE_PROMPT.format(
            floor=json.dumps(req.campaignConstraints.termFloor.model_dump(exclude_none=True)),
            ceiling=json.dumps(req.campaignConstraints.termCeiling.model_dump(exclude_none=True)),
            tone=req.campaignConstraints.tone or "professional",
            round=req.round,
            max_rounds=req.maxRounds,
            current_offer=json.dumps(req.currentOffer.model_dump(exclude_none=True)),
            creator_reply=req.creatorReply,
            history=json.dumps([e.model_dump(exclude_none=True) for e in req.negotiationHistory]),
        )

        def negotiate_node(state: dict) -> dict:
            return {"raw": llm.invoke(state["prompt"]).content}

        graph = StateGraph(dict)
        graph.add_node("negotiate", negotiate_node)
        graph.set_entry_point("negotiate")
        graph.add_edge("negotiate", END)
        compiled = graph.compile()

        result = compiled.invoke({"prompt": prompt})
        raw: str = result.get("raw", "")

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                return None
            parsed = json.loads(m.group())

        action = parsed.get("action", "")
        if action not in ("ACCEPT", "COUNTER", "REJECT", "ESCALATE"):
            return None

        resp = NegotiateResponse(action=action)  # type: ignore[arg-type]
        if parsed.get("proposedTerms"):
            resp.proposedTerms = parsed["proposedTerms"]
        if parsed.get("responseDraft"):
            resp.responseDraft = parsed["responseDraft"]
        if parsed.get("reasoning"):
            resp.reasoning = parsed["reasoning"]
        return resp

    except Exception as exc:  # noqa: BLE001
        print(f"[negotiate] LangGraph error: {exc} — falling back to mock")
        return None


def _try_langgraph_draft(req: DraftRequest) -> DraftResponse | None:
    try:
        from langchain_openai import ChatOpenAI  # type: ignore[import]
        from langgraph.graph import StateGraph, END  # type: ignore[import]
    except ImportError:
        return None

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None

    try:
        llm = ChatOpenAI(model="gpt-4o-mini", temperature=0.7, api_key=api_key)

        extra_parts = []
        if req.round:
            extra_parts.append(f"Follow-up number: {req.round}")
        if req.proposedTerms:
            extra_parts.append(f"Proposed terms: {json.dumps(req.proposedTerms)}")

        prompt = _DRAFT_PROMPT.format(
            purpose=req.purpose.replace("_", " "),
            name=req.creatorName,
            platform=req.creatorPlatform or "social media",
            niche=req.creatorNiche or "content creation",
            sender=req.senderName or "Pluvus Partnerships",
            extra="\n".join(extra_parts),
        )

        def draft_node(state: dict) -> dict:
            return {"raw": llm.invoke(state["prompt"]).content}

        graph = StateGraph(dict)
        graph.add_node("draft", draft_node)
        graph.set_entry_point("draft")
        graph.add_edge("draft", END)
        compiled = graph.compile()

        result = compiled.invoke({"prompt": prompt})
        raw: str = result.get("raw", "")

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                return None
            parsed = json.loads(m.group())

        if "subject" not in parsed or "body" not in parsed:
            return None

        return DraftResponse(subject=parsed["subject"], body=parsed["body"])

    except Exception as exc:  # noqa: BLE001
        print(f"[draft] LangGraph error: {exc} — falling back to mock")
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/negotiate", response_model=NegotiateResponse)
def negotiate(req: NegotiateRequest) -> NegotiateResponse:
    # Hard stop — enforce maxRounds at the service boundary.
    if req.round >= req.maxRounds:
        return NegotiateResponse(
            action="REJECT",
            reasoning=f"Max rounds ({req.maxRounds}) reached",
        )

    result = _try_langgraph_negotiate(req)
    if result is None:
        result = _mock_negotiate(req)
    return result


@router.post("/draft", response_model=DraftResponse)
def draft(req: DraftRequest) -> DraftResponse:
    result = _try_langgraph_draft(req)
    if result is None:
        result = _mock_draft(req)
    return result
