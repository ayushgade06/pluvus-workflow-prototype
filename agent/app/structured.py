"""
Schema-enforced structured output with bounded retry (FIX-6).

The classifier and negotiator ask the LLM for JSON as free text. Previously the
parse path was "json.loads, and on failure scrape with a brace regex, and on a
bad field guess with another regex" — a free-text guess that can silently latch
onto the wrong value. That is replaced here with the production pattern:

    parse  ->  validate against a Pydantic schema  ->  on failure, RE-ASK the
    model (bounded retries)  ->  raise StructuredOutputError if still invalid.

The decision/route layer decides how to fail safe (classifier → UNKNOWN/low
confidence; negotiator → propagate, which the route maps to its escalate/500
path). No prompt wording is changed and no provider is assumed — this works for
both the Ollama and OpenAI backends behind app.llm.get_llm.
"""

from __future__ import annotations

import json
import re
from typing import Type, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)


class StructuredOutputError(ValueError):
    """Raised when the model could not produce schema-valid output within the
    allowed number of attempts. Carries the last raw output for logging."""

    def __init__(self, message: str, *, raw: str | None = None) -> None:
        super().__init__(message)
        self.raw = raw


def extract_json_object(raw: str) -> dict:
    """Pull a JSON object out of a raw model response.

    Tolerates ```json fences and leading/trailing prose by falling back to the
    first balanced-looking brace span. This is the *parse* step only — the
    result is still validated against a schema by the caller.
    """
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise ValueError(f"No JSON object found in model response: {raw!r}")
        obj = json.loads(m.group())
    if not isinstance(obj, dict):
        raise ValueError(f"Expected a JSON object, got {type(obj).__name__}: {raw!r}")
    return obj


_REPAIR_SUFFIX = (
    "\n\nYour previous response was not valid. "
    "Respond with ONLY a single valid JSON object matching the requested shape, "
    "no prose, no code fences. Error: {error}"
)


def invoke_structured(
    llm,
    prompt: str,
    schema: Type[T],
    *,
    retries: int = 2,
) -> T:
    """Invoke the LLM and return a validated instance of `schema`.

    Tries up to ``1 + retries`` times. Each retry re-asks the model with a short
    repair instruction appended (the original prompt is otherwise unchanged).
    Raises StructuredOutputError if no attempt yields schema-valid JSON.
    """
    last_error: str = "no attempts made"
    last_raw: str | None = None
    attempts = max(1, 1 + retries)

    for attempt in range(attempts):
        ask = prompt if attempt == 0 else prompt + _REPAIR_SUFFIX.format(error=last_error)
        raw = llm.invoke(ask).content
        last_raw = raw if isinstance(raw, str) else str(raw)
        try:
            obj = extract_json_object(last_raw)
            return schema.model_validate(obj)
        except (ValueError, ValidationError) as exc:
            last_error = str(exc)

    raise StructuredOutputError(
        f"Model did not produce schema-valid output after {attempts} attempt(s): {last_error}",
        raw=last_raw,
    )
