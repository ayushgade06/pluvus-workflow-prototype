"""Unit tests for schema-enforced structured output with retry (FIX-6).

Covers app.structured (the generic helper) and the classify/negotiate wiring,
using a fake LLM so no real model is required. Pure + deterministic.
"""

import pytest
from pydantic import BaseModel

from app.structured import (
    StructuredOutputError,
    extract_json_object,
    invoke_structured,
)


class FakeLLM:
    """Returns a pre-seeded list of `.content` strings, one per invoke()."""

    def __init__(self, outputs):
        self._outputs = list(outputs)
        self.calls = 0

    def invoke(self, _prompt):
        out = self._outputs[min(self.calls, len(self._outputs) - 1)]
        self.calls += 1

        class _R:
            content = out

        return _R()


class _Schema(BaseModel):
    intent: str
    confidence: float = 0.5


# ---------------------------------------------------------------------------
# extract_json_object
# ---------------------------------------------------------------------------


def test_extract_plain_json():
    assert extract_json_object('{"a": 1}') == {"a": 1}


def test_extract_strips_code_fence():
    assert extract_json_object('```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_from_surrounding_prose():
    assert extract_json_object('Sure! Here:\n{"a": 1}\nHope that helps') == {"a": 1}


def test_extract_no_object_raises():
    with pytest.raises(ValueError):
        extract_json_object("no json here")


def test_extract_non_object_raises():
    with pytest.raises(ValueError):
        extract_json_object("[1, 2, 3]")


# ---------------------------------------------------------------------------
# invoke_structured
# ---------------------------------------------------------------------------


def test_valid_on_first_try():
    llm = FakeLLM(['{"intent": "POSITIVE", "confidence": 0.9}'])
    out = invoke_structured(llm, "p", _Schema, retries=2)
    assert out.intent == "POSITIVE"
    assert llm.calls == 1


def test_retries_then_succeeds():
    llm = FakeLLM(["garbage", '{"intent": "NEGATIVE"}'])
    out = invoke_structured(llm, "p", _Schema, retries=2)
    assert out.intent == "NEGATIVE"
    assert llm.calls == 2  # one failure, one success


def test_raises_after_exhausting_retries():
    llm = FakeLLM(["x", "y", "z"])
    with pytest.raises(StructuredOutputError):
        invoke_structured(llm, "p", _Schema, retries=2)
    assert llm.calls == 3  # 1 + 2 retries


def test_schema_validation_failure_triggers_retry():
    # First response is valid JSON but missing required `intent` → must retry.
    llm = FakeLLM(['{"confidence": 0.8}', '{"intent": "QUESTION"}'])
    out = invoke_structured(llm, "p", _Schema, retries=2)
    assert out.intent == "QUESTION"
    assert llm.calls == 2


def test_error_carries_last_raw():
    llm = FakeLLM(["nope"])
    try:
        invoke_structured(llm, "p", _Schema, retries=0)
    except StructuredOutputError as exc:
        assert exc.raw == "nope"
    else:  # pragma: no cover
        pytest.fail("expected StructuredOutputError")
