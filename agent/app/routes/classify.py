"""
POST /classify — reply intent classification

LLM backend is chosen by the LLM_PROVIDER env var (ollama | openai) via
app.llm.get_llm — see app/llm.py. No code edits to swap providers.

Input:  { "message": "I'd love to collaborate." }
Output: { "intent": "POSITIVE", "confidence": 0.94, "reasoning": "..." }
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from app.llm import get_llm
from app.structured import StructuredOutputError, invoke_structured

router = APIRouter()
logger = logging.getLogger("agent.classify")

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


class _ClassifyLLMOutput(BaseModel):
    """Schema the model output is validated against AS PRODUCED (FIX-6).

    `intent` must be one of the enum values — an invalid intent fails validation
    and forces a model retry instead of a regex guess. `confidence` is coerced
    to a float and clamped to [0, 1].
    """

    intent: ReplyIntent
    confidence: float = 0.5
    reasoning: str | None = None

    @field_validator("confidence", mode="before")
    @classmethod
    def _coerce_confidence(cls, v: object) -> float:
        try:
            f = float(v)  # tolerate "0.94" strings
        except (TypeError, ValueError):
            return 0.5
        return max(0.0, min(1.0, f))


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------

_CLASSIFY_PROMPT = """\
You are a classification assistant for an influencer outreach platform.

Given an email reply from a creator, classify their intent into exactly one of:
- POSITIVE  : they are interested in collaborating
- NEGATIVE  : they are not interested
- QUESTION  : they have a question but haven't committed either way
- OPT_OUT   : they want to stop receiving emails
- UNKNOWN   : the intent is genuinely ambiguous

Respond in JSON with this exact shape and nothing else:
{{"intent": "<INTENT>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}}

Reply to classify:
{message}
"""

def _langgraph_classify(message: str) -> ClassifyResponse:
    from langgraph.graph import StateGraph, END  # type: ignore[import]

    llm = get_llm(temperature=0)

    def classify_node(state: dict) -> dict:
        prompt = _CLASSIFY_PROMPT.format(message=state["message"])
        # FIX-6: validate the model output against _ClassifyLLMOutput AS PRODUCED,
        # retrying the model on invalid output instead of regex-scraping a guess.
        # On total failure, fail SAFE to UNKNOWN/low-confidence so the existing
        # low-confidence gate routes the reply to MANUAL_REVIEW.
        try:
            parsed = invoke_structured(llm, prompt, _ClassifyLLMOutput, retries=2)
            out = ClassifyResponse(
                intent=parsed.intent,
                confidence=parsed.confidence,
                reasoning=parsed.reasoning,
            )
        except StructuredOutputError as exc:
            logger.warning("classify structured-output failed, routing to UNKNOWN: %s", exc)
            out = ClassifyResponse(
                intent="UNKNOWN",
                confidence=0.0,
                reasoning="classifier output invalid after retries",
            )
        return {"result": out}

    graph = StateGraph(dict)
    graph.add_node("classify", classify_node)
    graph.set_entry_point("classify")
    graph.add_edge("classify", END)

    result = graph.compile().invoke({"message": message})
    return result["result"]


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.post("/classify", response_model=ClassifyResponse)
def classify(req: ClassifyRequest) -> ClassifyResponse:
    try:
        result = _langgraph_classify(req.message)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Classification failed: {exc}") from exc

    if result.confidence < LOW_CONFIDENCE_THRESHOLD:
        result = ClassifyResponse(
            intent="UNKNOWN",
            confidence=result.confidence,
            reasoning=f"low confidence ({result.confidence:.2f} < {LOW_CONFIDENCE_THRESHOLD})",
        )

    return result
