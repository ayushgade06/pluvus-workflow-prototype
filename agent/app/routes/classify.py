"""
POST /classify — reply intent classification

LLM backend (swap by commenting/uncommenting):
  - Ollama (local, default for dev)
  - OpenAI (prod — set OPENAI_API_KEY and flip the import below)

Input:  { "message": "I'd love to collaborate." }
Output: { "intent": "POSITIVE", "confidence": 0.94, "reasoning": "..." }
"""

from __future__ import annotations

import os
import re
import json
from typing import Literal

from fastapi import APIRouter, HTTPException
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
# LLM backend — swap here when moving to prod
# ---------------------------------------------------------------------------

def _get_llm():
    # ── Ollama (local dev) ──────────────────────────────────────────────────
    from langchain_ollama import ChatOllama  # type: ignore[import]
    return ChatOllama(
        model=os.getenv("OLLAMA_MODEL", "qwen2.5:7b"),
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        temperature=0,
    )

    # ── OpenAI (prod) ───────────────────────────────────────────────────────
    # from langchain_openai import ChatOpenAI  # type: ignore[import]
    # return ChatOpenAI(
    #     model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
    #     api_key=os.getenv("OPENAI_API_KEY"),
    #     temperature=0,
    # )


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

_INTENT_RE = re.compile(r'"intent"\s*:\s*"(POSITIVE|NEGATIVE|QUESTION|OPT_OUT|UNKNOWN)"')
_CONF_RE   = re.compile(r'"confidence"\s*:\s*([0-9.]+)')
_REASON_RE = re.compile(r'"reasoning"\s*:\s*"([^"]+)"')


def _parse_classify(raw: str) -> ClassifyResponse:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        parsed = json.loads(m.group()) if m else {}

    intent = parsed.get("intent", "UNKNOWN")
    confidence = float(parsed.get("confidence", 0.5))
    reasoning = parsed.get("reasoning")

    if intent not in {"POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN"}:
        # Fallback: regex scrape
        im = _INTENT_RE.search(raw)
        cm = _CONF_RE.search(raw)
        rm = _REASON_RE.search(raw)
        intent = im.group(1) if im else "UNKNOWN"
        confidence = float(cm.group(1)) if cm else 0.5
        reasoning = rm.group(1) if rm else None

    confidence = max(0.0, min(1.0, confidence))
    return ClassifyResponse(intent=intent, confidence=confidence, reasoning=reasoning)  # type: ignore[arg-type]


def _langgraph_classify(message: str) -> ClassifyResponse:
    from langgraph.graph import StateGraph, END  # type: ignore[import]

    llm = _get_llm()

    def classify_node(state: dict) -> dict:
        prompt = _CLASSIFY_PROMPT.format(message=state["message"])
        return {"raw": llm.invoke(prompt).content}

    graph = StateGraph(dict)
    graph.add_node("classify", classify_node)
    graph.set_entry_point("classify")
    graph.add_edge("classify", END)

    result = graph.compile().invoke({"message": message})
    return _parse_classify(result.get("raw", ""))


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
