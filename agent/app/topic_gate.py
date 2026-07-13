"""
Always-escalate topic gate (Phase E / founder #4, #5, #9, #11).

Certain topics must ALWAYS route to a human regardless of the model's confidence:
the agent may *acknowledge* the question, but it must never decide or commit on
these. Per the founder's answers these categories are:

  * legal / contract changes            (#5, #9)
  * disputes / hostile tone / payment
    disputes / missed deliverables      (#9)
  * pricing exceptions — custom fee
    structures, bonuses, guarantees     (#4, #5)
  * undefined / missing campaign terms  (#11)
  * commitment-bearing commercial asks
    the agent has no authority to grant:
    usage rights, exclusivity, licensing (#4, Q3)

This is the same model-independent enforcement pattern as the opt-out / injection
gates (app.injection): a deterministic keyword/heuristic scan whose hit forces an
escalation the model cannot override. It is deliberately CONSERVATIVE — it fires
only on clear category language — because a false positive sends an otherwise
handleable reply to a human. The money guards and confidence gate remain the
backstops for everything it doesn't catch.

Q3 (locked) — per-topic split. Not every "unknown structured term" escalates:

  * ESCALATE  when the unknown topic is a commercial COMMITMENT the agent can't
    grant on its own — usage rights, exclusivity, licensing (and content-usage /
    whitelisting-style asks). The agent may acknowledge but must hand to a human.

  * HONEST-DEFER (keep today's behavior — NOT escalated here) for benign
    scheduling / logistics: payment TIMING ("when do I get paid?"), which the
    negotiate/draft path already answers or defers honestly without a human.

The policy is an explicit ``TOPIC_POLICY`` map so it is auditable and easy to
extend. ``detect_escalation_topic`` consults it and returns ONLY topics whose
policy is "escalate"; a "defer" match returns None (the reply flows normally and
the honest-defer copy handles it).
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Per-topic policy (Q3)
# ---------------------------------------------------------------------------
# The single source of truth for what each detected topic does. "escalate" →
# always route to MANUAL_REVIEW regardless of confidence; "defer" → do NOT
# escalate on the topic alone (the normal path / honest-defer copy handles it).

TopicPolicy = str  # "escalate" | "defer"

TOPIC_POLICY: dict[str, TopicPolicy] = {
    # Always-escalate categories (judgment / legal / commercial commitment).
    "legal_or_contract": "escalate",
    "dispute_or_hostile": "escalate",
    "pricing_exception": "escalate",
    "undefined_terms": "escalate",
    "usage_rights_or_licensing": "escalate",
    # Benign scheduling / logistics — honest-defer, NOT a human handoff (Q3).
    "payment_timing": "defer",
}


# ---------------------------------------------------------------------------
# Deterministic category patterns
# ---------------------------------------------------------------------------
# Each topic maps to a list of conservative regexes. Kept narrow so a normal
# creator reply ("sounds good, when do we start?") does not trip an escalation.
# Ordering matters only for which reason is reported first on a multi-match; the
# escalate topics are checked before the defer topics so a reply that mentions
# BOTH licensing and payment timing escalates (the stricter policy wins).

_TOPIC_PATTERNS: dict[str, list[str]] = {
    # Legal / contract changes — the creator wants contract/legal edits.
    "legal_or_contract": [
        r"\b(?:contract|agreement|terms? of service|T&Cs?)\b.*\b(?:change|amend|revise|modify|edit|add|remove|clause|redline)\b",
        r"\b(?:my|our|the)\s+(?:lawyer|attorney|legal team|counsel)\b",
        r"\b(?:non[\s-]?disclosure|NDA|indemnif|liabilit|warrant(?:y|ies)|governing law|jurisdiction|arbitration)\b",
        r"\bsign(?:ed)? (?:a|an|the)?\s*(?:contract|agreement|nda)\b.*\b(?:before|first|change|different)\b",
        r"\b(?:add|include|need)\b.*\bclause\b",
    ],
    # Disputes / hostile tone / payment disputes / missed deliverables.
    "dispute_or_hostile": [
        r"\b(?:never (?:got|received) paid|haven'?t been paid|didn'?t get paid|still (?:waiting|owed)|you owe me|unpaid)\b",
        r"\b(?:breach|violat(?:e|ed|ion)|dispute|complaint|refund|chargeback|scam|fraud|misleading|false advertis)\b",
        r"\b(?:missed|late|overdue|didn'?t deliver|failed to deliver)\b.*\b(?:deliverable|payment|deadline|milestone)\b",
        r"\b(?:lawsuit|sue|legal action|take you to court|report you|BBB)\b",
        # Overt hostility toward the sender (kept narrow to avoid tone false-positives).
        r"\b(?:this is (?:a )?(?:scam|ripoff|joke|insulting|insult)|you'?re (?:a )?(?:scam|fraud|liars?|ripping me off))\b",
    ],
    # Pricing exceptions — custom fee structures / bonuses / guarantees the agent
    # is not authorized to invent (only the fixed fee is negotiable in V1).
    "pricing_exception": [
        r"\b(?:performance|milestone|tiered|per[\s-]?(?:click|view|sale|conversion|acquisition)|CPA|CPM|CPC|revenue[\s-]?shar|rev[\s-]?share|profit[\s-]?shar)\b.*\b(?:bonus|structure|deal|payment|rate|commission)\b",
        r"\b(?:guarantee|guaranteed)\b.*\b(?:minimum|payment|sales|results|ROI|amount)\b",
        r"\b(?:bonus|incentive|kicker|upfront (?:deposit|payment))\b.*\b(?:if|when|for (?:hitting|reaching)|on top)\b",
        r"\b(?:equity|profit share|revenue share|rev share|ownership stake)\b",
        r"\b(?:custom|special|different)\b.*\b(?:fee structure|payment structure|deal structure|commission structure)\b",
    ],
    # Commercial commitments the agent can't grant — usage rights / exclusivity /
    # licensing / whitelisting / content usage (Q3: escalate).
    "usage_rights_or_licensing": [
        r"\b(?:usage rights?|content rights?|image rights?|likeness)\b",
        r"\b(?:exclusiv(?:e|ity)|non[\s-]?compete|category exclusiv)\b",
        r"\b(?:licens(?:e|ing)|sublicens|perpetual (?:license|use|rights?)|in perpetuity)\b",
        r"\b(?:whitelist|whitelisting|allowlist|spark (?:ad|code)|boost(?:ing)? my (?:content|post))\b",
        r"\b(?:paid media|run (?:my|the) (?:content|creative) as (?:an )?ad|use my (?:content|video|post) (?:in|for) ads)\b",
        r"\b(?:who owns|ownership of)\b.*\b(?:content|footage|creative|assets?)\b",
    ],
    # Undefined / missing campaign terms — the creator asks about a required term
    # that is genuinely unspecified and commitment-bearing. Conservative: this is
    # a phrase-shaped catch for "what are the exact deliverables/terms" style asks
    # that the agent has no configured answer for; the negotiate/draft honest-defer
    # already covers benign unknowns, so this stays narrow.
    "undefined_terms": [
        r"\bwhat (?:exactly )?(?:are|is) the (?:full |complete |exact )?(?:contract|legal) terms\b",
        r"\bnothing (?:in (?:the|your) (?:brief|email|offer)|was) (?:specified|mentioned|defined) about\b.*\b(?:rights?|exclusivity|licens|contract|legal)\b",
    ],
    # Benign scheduling / payment TIMING — honest-defer (NOT escalated).
    "payment_timing": [
        r"\b(?:when|how soon|what(?:'s| is) the timeline|how long)\b.*\b(?:get paid|paid|payment|payout|invoice|receive (?:the )?(?:money|payment))\b",
        r"\b(?:payment (?:schedule|timing|timeline)|net[\s-]?\d+|net (?:30|45|60)|pay(?:ment)? terms)\b",
    ],
}

# Compile once. Escalate topics FIRST so the stricter policy is reported on a
# reply that matches both an escalate and a defer topic.
_ESCALATE_TOPICS = [t for t, p in TOPIC_POLICY.items() if p == "escalate"]
_DEFER_TOPICS = [t for t, p in TOPIC_POLICY.items() if p == "defer"]
_TOPIC_ORDER = _ESCALATE_TOPICS + _DEFER_TOPICS

_COMPILED: dict[str, re.Pattern[str]] = {
    topic: re.compile("|".join(_TOPIC_PATTERNS[topic]), re.IGNORECASE | re.DOTALL)
    for topic in _TOPIC_ORDER
    if topic in _TOPIC_PATTERNS
}


def detect_topic(text: str) -> str | None:
    """Return the first matching topic reason code (any policy), or None.

    Escalate topics are checked before defer topics, so on a reply that matches
    both the escalate topic is returned. Mostly a helper for detect_escalation_topic
    and tests; callers that only care about escalation should use that instead.
    """
    if not text:
        return None
    for topic in _TOPIC_ORDER:
        pattern = _COMPILED.get(topic)
        if pattern is not None and pattern.search(text):
            return topic
    return None


def detect_escalation_topic(text: str) -> str | None:
    """Return an always-escalate topic reason code, or None.

    A non-None result is a reason code (see TOPIC_POLICY / REASON_LABELS on the
    server) that the caller uses to force an escalation to MANUAL_REVIEW
    REGARDLESS of the model's confidence (#5). Topics whose policy is "defer"
    (payment timing) return None here so the normal honest-defer path handles
    them (Q3). The detection is deterministic, so a prompt injection or a
    confident-but-wrong model cannot suppress it.
    """
    topic = detect_topic(text)
    if topic is not None and TOPIC_POLICY.get(topic) == "escalate":
        return topic
    return None
