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
        # F-23: a demand to CHANGE the commission % (or split, or make it
        # commission-only). Commission is a fixed, non-negotiable term at the
        # brand's configured %, so a rewrite is a structural change only a human
        # may approve. The bare mention of "commission" is NOT enough (a plain
        # "what's the commission?" is answerable and stays out of this pattern
        # via the intent-aware split below); this matches only a specific new %
        # or an explicit change/removal of the commission term. (Note: no "\b"
        # after "%" — "%" is not a word char, so "%\b" fails before a space.)
        r"\bcommission\b.*?\d{1,3}\s*(?:%|percent)",
        r"\d{1,3}\s*(?:%|percent).*?\bcommission\b",
        r"\b(?:commission[\s-]?only|no (?:flat|base) fee,? just commission)\b",
        r"\b(?:raise|bump|increase|change|adjust|renegotiat\w*|rewrite)\b.*\bcommission\b",
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


# ---------------------------------------------------------------------------
# Intent-aware gating (F-Q1/Q2/T3)
# ---------------------------------------------------------------------------
# The original gate escalated a sensitive topic on KEYWORD PRESENCE alone. But a
# creator merely ASKING "is there exclusivity?" is different from DEMANDING "I
# require category exclusivity or I walk" — the first is answerable from the
# campaign knowledge fields (usageRights / exclusivity are literally configured),
# the second is a structural commitment only a human can grant. Escalating both
# collapses a bundled multi-question turn ("what's the fee, do I keep the shoes,
# and is there exclusivity?") to MANUAL_REVIEW with zero questions answered, even
# though we HAVE the answer (F-Q1/Q2/T3).
#
# The split applies ONLY to topics we can actually answer as a question — usage
# rights / exclusivity / licensing (`usage_rights_or_licensing`). The genuinely
# human-only topics (legal/contract review, disputes, custom pricing structures,
# undefined-terms) ALWAYS escalate regardless of phrasing: a question about a
# lawyer review or a payment dispute is not something the honest-defer copy can
# resolve. This is a deliberately narrow, conservative widening of what flows to
# the negotiator — a DEMAND on ANY sensitive topic still escalates.

# Topics for which a pure QUESTION *may* be answerable rather than escalated (it is
# answerable from the campaign knowledge fields, or honestly deferred). A DEMAND /
# removal / ultimatum on the SAME topic still escalates. NOTE: membership here is
# necessary but not sufficient — the matched text must ALSO be one of the
# knowledge-backed sub-topics (_ANSWERABLE_SUBTOPIC) to be suppressed, so a
# whitelisting / paid-media / ownership question (a genuine commitment we cannot
# answer from a field) still escalates even though it lives under the same topic.
_ANSWERABLE_AS_QUESTION: frozenset[str] = frozenset(
    {"usage_rights_or_licensing", "pricing_exception"}
)

# The sub-slice of an answerable topic we can actually ANSWER from the campaign
# knowledge fields, keyed by topic:
#   * usage_rights_or_licensing — usage-rights duration, category exclusivity, and
#     license/perpetual DURATION questions (from usageRights / exclusivity fields).
#     Whitelisting, paid-media/spark-ads, and content OWNERSHIP are EXCLUDED — those
#     are commitment-bearing asks with no configured answer, so a question about them
#     stays an escalate.
#   * pricing_exception — ONLY a plain commission question ("what's the commission?",
#     "is commission negotiable?"). The commission % is a configured, fixed field, so
#     a QUESTION is answerable ("10%, fixed"). Everything else under pricing_exception
#     (equity, guarantees, tiered/performance structures, bonuses) has NO configured
#     answer and always escalates — so the sub-topic pattern here matches commission
#     ONLY. A DEMAND to change the commission (F-23) still escalates via the intent
#     split below; only a bare question is suppressed.
# Only a QUESTION matching the topic's pattern (and NOT a demand) is suppressed.
_ANSWERABLE_SUBTOPIC_BY_TOPIC: dict[str, re.Pattern[str]] = {
    "usage_rights_or_licensing": re.compile(
        r"\b(?:usage rights?|content rights?|image rights?|likeness)\b"
        r"|\b(?:exclusiv(?:e|ity)|non[\s-]?compete|category exclusiv)\b"
        r"|\b(?:licens(?:e|ing)|sublicens|perpetual (?:license|use|rights?)|in perpetuity)\b",
        re.IGNORECASE,
    ),
    "pricing_exception": re.compile(r"\bcommission\b", re.IGNORECASE),
}

# The two pricing_exception patterns that fire on a QUOTED commission percentage
# (e.g. "the 10% commission"). These match agreement as well as a change-demand,
# so a same-rate quote must be checked against the configured rate before it
# escalates (see _pricing_is_only_same_rate_commission_quote).
_COMMISSION_PCT_QUOTE = re.compile(
    r"\bcommission\b[^.\d]{0,40}?(\d{1,3})\s*(?:%|percent)"
    r"|(\d{1,3})\s*(?:%|percent)[^.]{0,40}?\bcommission\b",
    re.IGNORECASE,
)
# The other pricing_exception patterns (equity, guarantees, tiered/performance,
# custom structures, commission-only) — these ALWAYS escalate regardless of the
# configured rate, so a same-rate suppression must NOT apply when one of these hit.
_PRICING_NON_QUOTE = re.compile(
    "|".join(
        p for p in _TOPIC_PATTERNS["pricing_exception"]
        if p not in (r"\bcommission\b.*?\d{1,3}\s*(?:%|percent)", r"\d{1,3}\s*(?:%|percent).*?\bcommission\b")
    ),
    re.IGNORECASE | re.DOTALL,
)


def _pricing_is_only_same_rate_commission_quote(
    text: str, commission_rate: float | None
) -> bool:
    """True when a clause tripped ``pricing_exception`` SOLELY because it quotes the
    commission percentage that EQUALS the brand's configured rate — i.e. the creator
    is agreeing to / restating the fixed commission, not asking to change it.

    Requires a configured ``commission_rate``. False when: no rate configured, the
    clause matches any OTHER pricing_exception shape (equity/guarantee/tiered/
    commission-only), the quoted number differs from the configured rate, or the
    clause reads as a change-DEMAND (``_DEMAND_SIGNAL``). Conservative: any doubt →
    False (escalate).
    """
    if commission_rate is None:
        return False
    # A genuine structural pricing ask (not a bare quote) always escalates.
    if _PRICING_NON_QUOTE.search(text):
        return False
    # A change-demand ("bump the commission", "make it 20%") always escalates.
    if _DEMAND_SIGNAL.search(text):
        return False
    m = _COMMISSION_PCT_QUOTE.search(text)
    if not m:
        return False
    quoted = m.group(1) or m.group(2)
    try:
        return int(quoted) == int(round(commission_rate))
    except (TypeError, ValueError):
        return False

# DEMAND / removal / ultimatum language: the creator is not asking about a term,
# they are trying to CHANGE, REMOVE, REQUIRE, or CONDITION THE DEAL on it. Any of
# these on a sensitive topic keeps the escalation even under intent-aware gating.
# Kept conservative and imperative/conditional in shape so a plain interrogative
# ("do you need exclusivity?", "what are the usage rights?") does not trip it.
_DEMAND_SIGNAL = re.compile(
    r"\b(?:"
    # explicit requirement / insistence. "i want" is a demand EXCEPT when it's
    # "i want to know/understand/ask/check/see/hear" — that's a question in
    # disguise, so a negative lookahead keeps it out of the demand bucket.
    r"i (?:require|need|insist|demand|must have)\b"
    r"|i want\b(?!\s+to\s+(?:know|understand|ask|check|see|hear|learn|confirm|clarify))"
    r"|(?:require|insist on|demand)\b"
    # removal / refusal of a term
    r"|(?:remove|drop|waive|strip|no)\s+(?:the\s+)?(?:usage|exclusiv\w*|licens\w*|reposting|whitelist\w*|rights?|clause)"
    r"|(?:won'?t|will not|refuse to|can'?t)\s+(?:grant|give|allow|agree to|do)\b"
    r"|no (?:usage rights?|license|licensing|reposting|whitelisting|category exclusiv\w*)"
    r"|you (?:can'?t|cannot|may not)\s+(?:repost|reshare|use|run|whitelist|boost)"
    # ultimatum / condition-the-deal-on-it
    r"|or (?:i'?m|i am|we'?re)\s+(?:out|done|walking)"
    r"|or (?:this|the deal)\s+(?:doesn'?t|won'?t|is off)"
    r"|or this (?:doesn'?t|does not|won'?t) happen"
    r"|take it or leave it"
    r"|(?:only|won'?t do it|not doing it)\s+(?:if|unless|without)\b"
    r"|deal ?breaker"
    # explicit "non-negotiable" / "that's final" — the creator has closed the
    # door on the term, so even a "?"-containing sentence is a demand, not a
    # question (tightens F-10: "…exclusivity clause? …$3000 fee. Non-negotiable").
    r"|non[\s-]?negotiable"
    r"|that'?s final\b"
    # F-23: commission-change demand shapes. A NEW commission % ("I want 40%",
    # "make it 20% commission", "bump my commission to 25%") is a demand to
    # rewrite a fixed term. Kept adjacent to commission/percent so a plain
    # "what's the commission?" (no new number, no imperative) is NOT a demand.
    r"|(?:want|need|make it|bump|raise|increase|change|adjust|give me)\b[^.]{0,20}?\d{1,3}\s*(?:%|percent)"
    # A change-verb DIRECTED AT the commission ("raise/change/bump the commission")
    # is a demand even without a new number. A bare quoted rate ("the 10% commission
    # you mentioned") is NOT — the creator is referencing the brand's own configured
    # rate, e.g. to ask whether it's on top of the fee. So we require an explicit
    # change verb here rather than matching a percent adjacent to "commission" (the
    # old form escalated any reply that merely QUOTED the 10% commission).
    r"|(?:raise|bump|increase|lower|change|adjust|rewrite|drop|remove|renegotiat\w*)\b[^.]{0,20}?\bcommission\b"
    # Ultimatum: "…40% or the deal's off". Kept to real deal-conditioning objects
    # (this / the deal) — NOT a bare "it", which false-matched "on top of the fee,
    # or instead of it" (a benign clarifying question).
    r"|\d{1,3}\s*(?:%|percent)[^.]{0,20}?\bor (?:this|the deal)\b"
    r"|commission[\s-]?only\b"
    r")",
    re.IGNORECASE,
)

# QUESTION shape: an interrogative opener or a clear "asking about" phrasing. Used
# only as a positive signal that the creator is inquiring (not demanding).
_QUESTION_SIGNAL = re.compile(
    r"(?:\?)"  # a literal question mark anywhere
    r"|^\s*(?:do|does|is|are|will|would|can|could|what|when|how|which|who|any)\b"
    r"|\b(?:do you (?:need|want|require)|is there (?:any|an)?|are there any|"
    r"how long|what (?:are|is|about)|will you|would you|can i|could i|just "
    r"(?:wondering|checking)|curious (?:about|if)|wanted to (?:know|ask|check)|"
    r"quick question|any (?:exclusivity|usage|licensing))\b",
    re.IGNORECASE,
)


def classify_topic_intent(text: str, topic: str) -> str:
    """Classify whether the creator is ASKING ABOUT a sensitive `topic` or making a
    DEMAND about it. Returns "question" or "demand".

    Deterministic and conservative: a DEMAND signal (require/remove/ultimatum,
    see _DEMAND_SIGNAL) wins — it is the safety-relevant case, so any ambiguity
    biases toward "demand" (escalate). Only when there is NO demand language AND a
    positive question signal is present do we call it a "question". A sensitive
    keyword with neither a demand nor a question shape (a bare statement, e.g.
    "the usage rights matter to me") is treated as a "demand" so it still
    escalates — we never widen the answerable path on ambiguity.
    """
    if not text:
        return "demand"
    if _DEMAND_SIGNAL.search(text):
        return "demand"
    if _QUESTION_SIGNAL.search(text):
        return "question"
    return "demand"


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

    F-Q1/Q2/T3 — intent-aware: for a topic in ``_ANSWERABLE_AS_QUESTION`` (usage
    rights / exclusivity / licensing), a PURE QUESTION does NOT escalate — it flows
    to the negotiator, which answers it from the campaign knowledge fields (or
    defers honestly). A DEMAND / removal / ultimatum on the same topic still
    escalates. Every other escalate topic (legal, dispute, pricing-exception,
    undefined-terms) escalates regardless of phrasing. Ambiguity biases to
    escalate (see ``classify_topic_intent``), so this only widens the answerable
    path for an unambiguous question.
    """
    topic, _ = detect_escalation_topic_ex(text)
    return topic


def detect_escalation_topic_ex(
    text: str, commission_rate: float | None = None
) -> tuple[str | None, str | None]:
    """Intent-aware variant returning ``(escalation_topic, answered_question_topic)``.

    Exactly one of the two is non-None (or both None for no sensitive topic):
      * ``escalation_topic`` — a reason code the caller must escalate on.
      * ``answered_question_topic`` — a sensitive topic that was DETECTED but
        SUPPRESSED because it was phrased as an answerable question. The caller
        does NOT escalate; it lets the reply flow so the knowledge fields answer
        it. Surfaced so a caller can log / annotate that a topic was recognized
        but intentionally not escalated.

    ``commission_rate`` — the brand's configured commission %. When provided, a
    clause that trips ``pricing_exception`` SOLELY by quoting the SAME percentage
    (the creator agreeing to / restating the fixed commission, e.g. "happy with the
    10% commission") is NOT escalated — only a DIFFERENT percentage, a change-demand,
    or any other pricing-exception shape (equity / guarantee / tiered / commission-
    only) still escalates. Omit it (None) to keep the original always-escalate
    behavior for any quoted commission percentage.

    This is the primitive; ``detect_escalation_topic`` returns just the first
    element for backward compatibility.
    """
    topic = detect_topic(text)
    if topic is None or TOPIC_POLICY.get(topic) != "escalate":
        return None, None
    # Same-rate commission agreement: a clause that tripped pricing_exception only
    # because it quotes the CONFIGURED commission % is the creator accepting the
    # fixed term, not asking to change it — flow it to the negotiator so the deal
    # can close. A different %, a change-demand, or any other pricing shape still
    # escalates (see _pricing_is_only_same_rate_commission_quote).
    if topic == "pricing_exception" and _pricing_is_only_same_rate_commission_quote(
        text, commission_rate
    ):
        return None, topic
    # Intent-aware suppression: only for an answerable topic, only when the matched
    # text is that topic's knowledge-backed sub-topic (usage/exclusivity/license —
    # NOT whitelisting/paid-media/ownership; commission — NOT equity/guarantees/
    # tiered structures), and only when it reads as a QUESTION (not a demand/
    # removal/ultimatum). All three must hold, or we escalate.
    subtopic = _ANSWERABLE_SUBTOPIC_BY_TOPIC.get(topic)
    if (
        topic in _ANSWERABLE_AS_QUESTION
        and subtopic is not None
        and subtopic.search(text)
        and classify_topic_intent(text, topic) == "question"
    ):
        return None, topic
    return topic, None


# ---------------------------------------------------------------------------
# BUG-A1: per-clause topic gating (multi-question collapse)
# ---------------------------------------------------------------------------
# The whole-reply gate above escalates a MULTI-question turn the instant ONE
# clause touches an escalate-topic keyword — losing the answerable questions:
#   "Love it! What is the fee, when do I get paid, and I will need a signed NDA?"
# has two answerable questions (fee, payment timing) AND one escalate clause (the
# NDA). Running the gate on the WHOLE string escalated the entire turn (the NDA
# keyword matched) → fee + timing lost to the Manual Queue with a bare handoff.
#
# `detect_escalation_per_clause` splits the reply into clauses and runs the SAME
# intent-aware gate PER CLAUSE, then decides:
#   * If NO clause escalates → nothing to escalate (identical to today).
#   * If a clause escalates AND at least one OTHER clause is genuinely answerable
#     (a non-sensitive question/statement — fee, timing, a plain "love it"), the
#     turn is NOT a bare escalate: it FLOWS to the negotiator (which answers the
#     answerable clauses) and the escalated clause is SURFACED so the caller can
#     put it in creatorQuestions for the human. `escalate_now` is False here.
#   * If a clause escalates AND there is NO answerable clause (the whole reply is
#     just the escalate-topic DEMAND — "I will sue you", "I need a signed NDA
#     before we start") → `escalate_now` is True: the always-escalate legal/
#     dispute DEMAND path is preserved exactly, never weakened.
#
# Deliberately conservative: a clause that ITSELF bundles an escalate-topic with a
# question still escalates that clause (the per-clause gate's own intent-aware
# question carve-out already lets a pure usage/commission QUESTION through). Only a
# SEPARATE answerable clause opens the flow-to-model path.

# Clause boundaries — CONSERVATIVE. We split only on boundaries that reliably
# separate DISTINCT asks: sentence terminators (. ? ! ;) and a comma/"and"/"but"
# that introduces a NEW interrogative ("what is the fee, and when do I get paid,
# and I need an NDA"). We deliberately do NOT split on bare "plus"/","/" and "
# between non-question fragments, so a single demand ("$400 plus perpetual usage
# rights, non-negotiable") is NOT shredded into false "answerable" fragments —
# that would weaken the always-escalate DEMAND path (forbidden).
_CLAUSE_BOUNDARY_RE = re.compile(
    r"[.?!;]+\s*"
    r"|,\s+and\s+(?=(?:i\b|by\b|for\b|remind me\b|honestly\b)?\s*"
    r"(?:what|when|where|which|why|how|do|does|did|can|could|would|will|is|are|any|whether)\b)"
    r"|,\s+(?=(?:what|when|where|which|why|how|do|does|did|can|could|would|will|is|are|any|whether)\b)"
    r"|\s+and\s+(?=(?:i\b|by\b|for\b|remind me\b|honestly\b)?\s*"
    r"(?:what|when|where|which|why|how|do|does|did|can|could|would|will|is|are|any|whether)\b)",
    re.IGNORECASE,
)

# An "answerable" clause is one the negotiator can actually handle: a QUESTION or
# an engaged statement about a NON-sensitive term (fee, payment timing, start
# date, deliverables, a plain "love it"). We require a positive answerable SHAPE —
# not merely "non-trivial words" — so a fragment of a demand ("$400", "non-
# negotiable") does NOT count as answerable. This keeps the flow-to-model path
# open ONLY when there is a genuine answerable question/statement alongside the
# escalate clause (the A1 scenario), and never on a bare demand.
_ANSWERABLE_CLAUSE_RE = re.compile(
    r"\?"  # a question mark
    r"|^\s*(?:what|when|where|which|who|why|how|do|does|did|can|could|would|will|"
    r"is|are|any|whether|could you|can you|would you|remind me|tell me|let me know|"
    r"just wondering|curious|wanted to know)\b"
    r"|\b(?:the fee|my fee|the rate|the pay|get paid|when do (?:i|we)|how (?:much|soon)|"
    r"the timeline|start date|when (?:do|does|can) (?:we|i|it)|deliverable|turnaround|"
    r"how many|which platform|what platform)\b"
    r"|^\s*(?:love it|sounds (?:good|great)|i'?m in|count me in|let'?s do it|"
    r"happy to|excited|interested)\b",
    re.IGNORECASE,
)


def _split_clauses(text: str) -> list[str]:
    """Split a creator reply into clause-sized units for per-clause gating.
    Conservative: drops empties, keeps order, never raises."""
    if not text:
        return []
    return [c.strip() for c in _CLAUSE_BOUNDARY_RE.split(text) if c and c.strip()]


class PerClauseGateResult:
    """Structured result of the per-clause topic gate (BUG-A1).

    Attributes:
      escalate_now       — True → the caller MUST escalate to a human now (a
                           demand on an escalate-topic with nothing else to answer,
                           OR the whole reply is a single escalate clause). False →
                           the turn may flow to the negotiator.
      escalation_topic   — the reason code of the offending clause, or None. Set
                           whenever an escalate clause was found (whether or not we
                           escalate now) so the caller can annotate the Manual
                           Queue / creatorQuestions.
      escalated_clauses  — the raw text of each clause that carried an escalate
                           topic (surfaced into creatorQuestions on the flow path
                           so the human still sees the sensitive ask).
      answerable_clauses — the clauses that did NOT escalate (fee/timing/etc.).
    """

    __slots__ = ("escalate_now", "escalation_topic", "escalated_clauses", "answerable_clauses")

    def __init__(
        self,
        escalate_now: bool,
        escalation_topic: str | None,
        escalated_clauses: list[str],
        answerable_clauses: list[str],
    ) -> None:
        self.escalate_now = escalate_now
        self.escalation_topic = escalation_topic
        self.escalated_clauses = escalated_clauses
        self.answerable_clauses = answerable_clauses


def detect_escalation_per_clause(
    text: str, commission_rate: float | None = None
) -> PerClauseGateResult:
    """Per-clause topic gate (BUG-A1). See PerClauseGateResult / module notes.

    Splits ``text`` into clauses and runs the intent-aware escalation gate on each.
    Decides whether the turn must escalate NOW (bare handoff) or may flow to the
    negotiator with the escalated clause surfaced for the human.

    ``commission_rate`` — the brand's configured commission %, threaded to the
    per-clause gate so a clause that merely quotes the SAME rate (agreement) is not
    escalated as a pricing exception. A DIFFERENT rate / change-demand still is.
    """
    clauses = _split_clauses(text)
    if not clauses:
        # No splittable content — fall back to whole-text gating for safety.
        whole, _answered = detect_escalation_topic_ex(text, commission_rate)
        return PerClauseGateResult(
            escalate_now=whole is not None,
            escalation_topic=whole,
            escalated_clauses=[text] if whole is not None else [],
            answerable_clauses=[],
        )

    escalation_topic: str | None = None
    escalated_clauses: list[str] = []
    answerable_clauses: list[str] = []

    for clause in clauses:
        topic, _answered = detect_escalation_topic_ex(clause, commission_rate)
        if topic is not None:
            escalated_clauses.append(clause)
            if escalation_topic is None:
                escalation_topic = topic  # first offending topic wins the reason
        elif _ANSWERABLE_CLAUSE_RE.search(clause):
            # A non-escalating clause that has an ANSWERABLE shape (a question, a
            # fee/timing ask, or engaged interest) — the negotiator can handle it.
            answerable_clauses.append(clause)

    if escalation_topic is None:
        # Nothing sensitive → not an escalation (the answerable path handles it).
        return PerClauseGateResult(False, None, [], answerable_clauses)

    # An escalate clause exists. Escalate NOW only when there is NOTHING answerable
    # to salvage — i.e. the whole turn is the escalate-topic demand. Otherwise flow
    # to the negotiator and surface the escalated clause for the human. This is the
    # A1 fix: the always-escalate DEMAND path stands when it's the whole reply, but
    # a bundled multi-question turn keeps its answerable questions.
    escalate_now = len(answerable_clauses) == 0
    return PerClauseGateResult(
        escalate_now=escalate_now,
        escalation_topic=escalation_topic,
        escalated_clauses=escalated_clauses,
        answerable_clauses=answerable_clauses,
    )
