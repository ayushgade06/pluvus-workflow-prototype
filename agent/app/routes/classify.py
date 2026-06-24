"""
POST /classify — reply intent classification

Uses a simple prompt-based LangGraph graph when OPENAI_API_KEY is set.
Falls back to a keyword-based mock classifier automatically when no key is
present, so the system runs without credentials.

Input:  { "message": "I'd love to collaborate." }
Output: { "intent": "POSITIVE", "confidence": 0.94, "reasoning": "..." }
"""

from __future__ import annotations

import os
import re
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# ---------------------------------------------------------------------------
# Shared types
# ---------------------------------------------------------------------------

ReplyIntent = Literal["POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN"]

LOW_CONFIDENCE_THRESHOLD = 0.70


class ClassifyRequest(BaseModel):
    message: str


class ClassifyResponse(BaseModel):
    intent: ReplyIntent
    confidence: float
    reasoning: str | None = None


# ---------------------------------------------------------------------------
# Keyword-based mock classifier
# ---------------------------------------------------------------------------
# Used when OPENAI_API_KEY is absent. Deterministic and fast.

_OPT_OUT = [
    "unsubscribe", "remove me", "opt out", "opt-out", "stop emailing",
    "take me off", "do not contact", "please remove",
]
_NEGATIVE = [
    "not interested", "no thanks", "no thank you", "decline", "pass",
    "don't want", "not at this time", "not right now",
]
_POSITIVE = [
    "yes", "interested", "love to", "sounds great", "definitely", "absolutely",
    "would love", "happy to", "excited", "let's do it", "let's talk", "sure",
]
_QUESTION = ["?", "what is", "what are", "how much", "how does", "tell me more",
             "can you", "could you", "commission", "rate", "details", "when", "where"]


def _keyword_classify(message: str) -> ClassifyResponse:
    lower = message.lower()
    if any(kw in lower for kw in _OPT_OUT):
        return ClassifyResponse(intent="OPT_OUT", confidence=0.95, reasoning="opt-out keyword match")
    if any(kw in lower for kw in _NEGATIVE):
        return ClassifyResponse(intent="NEGATIVE", confidence=0.95, reasoning="negative keyword match")
    if any(kw in lower for kw in _POSITIVE):
        return ClassifyResponse(intent="POSITIVE", confidence=0.95, reasoning="positive keyword match")
    if any(kw in lower for kw in _QUESTION):
        return ClassifyResponse(intent="QUESTION", confidence=0.85, reasoning="question keyword match")
    return ClassifyResponse(intent="UNKNOWN", confidence=0.50, reasoning="no keyword match")


# ---------------------------------------------------------------------------
# LangGraph classifier
# ---------------------------------------------------------------------------
# Only imported when langgraph + langchain-openai are installed and
# OPENAI_API_KEY is present.

_CLASSIFY_PROMPT = """\
You are a classification assistant for an influencer outreach platform.

Given an email reply from a creator, classify their intent into exactly one of:
- POSITIVE  : they are interested in collaborating
- NEGATIVE  : they are not interested
- QUESTION  : they have a question but haven't committed either way
- OPT_OUT   : they want to stop receiving emails
- UNKNOWN   : the intent is genuinely ambiguous

Respond in JSON with this exact shape:
{{"intent": "<INTENT>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}}

Reply to classify:
{message}
"""

_INTENT_PATTERN = re.compile(r'"intent"\s*:\s*"(POSITIVE|NEGATIVE|QUESTION|OPT_OUT|UNKNOWN)"')
_CONF_PATTERN = re.compile(r'"confidence"\s*:\s*([0-9.]+)')
_REASON_PATTERN = re.compile(r'"reasoning"\s*:\s*"([^"]+)"')


def _try_langgraph_classify(message: str) -> ClassifyResponse | None:
    try:
        from langchain_openai import ChatOpenAI  # type: ignore[import]
        from langgraph.graph import StateGraph, END  # type: ignore[import]
        import json
    except ImportError:
        return None

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None

    try:
        llm = ChatOpenAI(model="gpt-4o-mini", temperature=0, api_key=api_key)

        def classify_node(state: dict) -> dict:
            prompt = _CLASSIFY_PROMPT.format(message=state["message"])
            response = llm.invoke(prompt)
            return {"raw": response.content}

        graph = StateGraph(dict)
        graph.add_node("classify", classify_node)
        graph.set_entry_point("classify")
        graph.add_edge("classify", END)
        app = graph.compile()

        result = app.invoke({"message": message})
        raw: str = result.get("raw", "")

        # Parse JSON from the LLM response
        try:
            parsed = json.loads(raw)
            intent = parsed.get("intent", "UNKNOWN")
            confidence = float(parsed.get("confidence", 0.5))
            reasoning = parsed.get("reasoning")
        except (json.JSONDecodeError, ValueError):
            # Fallback: regex extraction
            im = _INTENT_PATTERN.search(raw)
            cm = _CONF_PATTERN.search(raw)
            rm = _REASON_PATTERN.search(raw)
            intent = im.group(1) if im else "UNKNOWN"
            confidence = float(cm.group(1)) if cm else 0.5
            reasoning = rm.group(1) if rm else None

        valid_intents = {"POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN"}
        if intent not in valid_intents:
            intent = "UNKNOWN"
        confidence = max(0.0, min(1.0, confidence))

        return ClassifyResponse(intent=intent, confidence=confidence, reasoning=reasoning)  # type: ignore[arg-type]

    except Exception as exc:  # noqa: BLE001
        print(f"[classify] LangGraph classification error: {exc} — falling back to mock")
        return None


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post("/classify", response_model=ClassifyResponse)
def classify(req: ClassifyRequest) -> ClassifyResponse:
    result = _try_langgraph_classify(req.message)
    if result is None:
        result = _keyword_classify(req.message)

    # Apply low-confidence threshold: override to UNKNOWN if below threshold.
    # This mirrors the server-side guard in replyDetection.ts, providing a
    # second enforcement layer at the service boundary.
    if result.confidence < LOW_CONFIDENCE_THRESHOLD:
        result = ClassifyResponse(
            intent="UNKNOWN",
            confidence=result.confidence,
            reasoning=f"low confidence ({result.confidence:.2f} < {LOW_CONFIDENCE_THRESHOLD})",
        )

    return result
