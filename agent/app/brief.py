"""HARD-K1: campaign brief PDF text extraction.

The campaign brief PDF (uploaded by the brand, attached to the Content Brief
email) contains the ground-truth campaign terms — deliverables, usage rights,
payment schedule, exclusivity, attribution — that the negotiation agent
previously had NO structured source for and therefore hallucinated by
construction (see hard.md HARD-K1 / HARD-P2).

This module turns the PDF bytes into plain text so the extracted knowledge can be
threaded into the /draft (and, later, /negotiate) LLM context. The TS engine owns
the file (local storage), so it POSTs the bytes here once per run and threads the
returned text back into campaignContext as `briefKnowledge`. Parsing lives here,
not in TS, because the agent already carries a PDF parser (pypdf) and this keeps
the extraction beside the LLM that consumes it.
"""

from __future__ import annotations

import io
import logging
import re

logger = logging.getLogger("agent.brief")

# Hard cap on the extracted knowledge fed to the model. A brief can be many pages;
# only the first chunk is realistically useful as negotiation context, and an
# unbounded blob would blow a small local model's context window. The TS side
# also treats this as advisory context, not authoritative — the structured
# knowledge fields (usageRights/exclusivity/…) remain the primary source.
MAX_BRIEF_CHARS = 4000


def extract_brief_text(pdf_bytes: bytes, *, max_chars: int = MAX_BRIEF_CHARS) -> str:
    """Extract plain text from a PDF's bytes, normalized and length-capped.

    Returns "" (never raises) on any parse failure or empty input — a brief we
    can't read must degrade to "no extra knowledge", never break a negotiation.
    """
    if not pdf_bytes:
        return ""
    try:
        from pypdf import PdfReader  # lazy import: only needed when a brief is parsed
    except Exception as exc:  # pragma: no cover - pypdf is a declared dependency
        logger.warning("brief: pypdf unavailable, skipping extraction: %s", exc)
        return ""

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        parts: list[str] = []
        total = 0
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:  # a single bad page shouldn't lose the whole brief
                continue
            if not text:
                continue
            parts.append(text)
            total += len(text)
            if total >= max_chars:
                break
        raw = "\n".join(parts)
    except Exception as exc:
        logger.warning("brief: PDF parse failed, returning empty: %s", exc)
        return ""

    return _normalize(raw)[:max_chars].strip()


def _normalize(text: str) -> str:
    """Collapse the ragged whitespace PDF extraction produces into readable prose:
    trim trailing spaces per line, drop blank runs, cap consecutive blank lines."""
    # Normalize newlines and strip per-line trailing whitespace.
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    # Collapse >1 blank line into a single blank line.
    out: list[str] = []
    blank = False
    for ln in lines:
        if ln.strip():
            out.append(re.sub(r"[ \t]{2,}", " ", ln))
            blank = False
        elif not blank:
            out.append("")
            blank = True
    return "\n".join(out).strip()
