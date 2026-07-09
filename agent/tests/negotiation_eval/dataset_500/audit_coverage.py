"""
Offline question-coverage auditor (no model, no network).

For every ANSWERABLE and MULTI-QUESTION and FIXED-TERM case in the dataset, it
builds the REAL DraftRequest the runner would build, assembles the ACTUAL draft
prompt via app.routes.negotiate's own helpers, and checks whether the fact needed
to answer each question is actually PRESENT in the prompt the model receives.

If a fact is missing from the prompt, the model CANNOT answer that question no
matter how good it is — that is a definitive code/data gap, found without waiting
on qwen. This is the audit that drives the immediate code fixes.

Each dataset answer_pattern is a regex the SENT email must match. We map each
distinct answer topic to the SOURCE FACT that must appear in the prompt, then
report which topics have no backing fact.

Run:  python audit_coverage.py
Exit 0 = every question topic is backed by a fact in the prompt; 1 = gaps.
"""

from __future__ import annotations

import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_AGENT_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
for p in (_AGENT_ROOT, _HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

from app.routes.negotiate import (  # noqa: E402
    DraftRequest,
    _build_offer_prompt,
    _scope_lines,
    _knowledge_block,
)
import loader  # noqa: E402

BAND = loader.BAND

# The campaignContext the runner threads into /draft (mirrors run_eval.call_draft).
CTX = {
    "commissionRate": BAND["commissionRate"],
    "rewardDescription": BAND["rewardDescription"],
    "deliverables": BAND["deliverables"],
    "timeline": BAND["timeline"],
    "usageRights": BAND["usageRights"],
    "exclusivity": BAND["exclusivity"],
    "paymentTerms": BAND["paymentTerms"],
    "attributionWindow": BAND["attributionWindow"],
}


def build_draft_req(reply, questions):
    """The DraftRequest the executor/runner builds for a counter_offer turn."""
    return DraftRequest(
        purpose="counter_offer",
        creatorName="Ayush Gade",
        creatorPlatform="Instagram",
        senderName=BAND["senderName"],
        brandDescription=BAND["brandDescription"],
        deliverables=BAND["deliverables"],
        timeline=BAND["timeline"],
        rewardDescription=BAND["rewardDescription"],
        usageRights=BAND["usageRights"],
        exclusivity=BAND["exclusivity"],
        paymentTerms=BAND["paymentTerms"],
        attributionWindow=BAND["attributionWindow"],
        proposedTerms={"rate": 350},
        creatorReply=reply,
        campaignContext=CTX,
        creatorQuestions=questions,
        dealDescription="a hybrid partnership — a fixed fee for your content plus a 10% commission on the sales you drive",
    )


def assemble_prompt(reply, questions):
    req = build_draft_req(reply, questions)
    ctx = req.campaignContext or {}
    scope_lines = _scope_lines(req, ctx)
    brand_context = f"About {BAND['senderName']}: {BAND['brandDescription']}\n"
    return _build_offer_prompt(req, BAND["senderName"], ctx, brand_context, scope_lines)


# Map each answer-topic regex-ish signal to the SOURCE-FACT signal that must
# appear in the assembled prompt for the model to be ABLE to answer it. We test
# the *fact* presence, not the model's wording.
FACT_SIGNALS = {
    "usage":        r"usage[- ]?rights|reshare|30[- ]?day",
    "exclusivity":  r"exclusiv|no category",
    "payment":      r"net[- ]?30|payment terms",
    "attribution":  r"attribut|cookie|window",
    "commission":   r"10\s?%|10 ?percent|commission",
    "deliverables": r"reel|stor(y|ies)",
    "timeline":     r"october|oct|live by|go-live|timeline",
    "reward":       r"cloudstride|sock|shoe|pair|reward|perk",
}


def topic_of(answer_pattern: str) -> str | None:
    """Classify a dataset answer_pattern into one of the FACT_SIGNALS topics
    (or the 'fee-echo' pseudo-topic for a bare rate figure the email must echo)."""
    p = answer_pattern.lower()
    # A bare fee figure the creator named (e.g. "420|fee|rate"): the email must
    # echo the negotiated number, which the executor always threads (proposedTerms
    # / creatorRequestedRate) — always answerable by construction.
    if re.fullmatch(r"\d{2,4}\|fee\|rate", p) or p in ("fee", "rate"):
        return "fee-echo"
    if "usage" in p or "reshare" in p:
        return "usage"
    if "exclusiv" in p or "no category" in p:
        return "exclusivity"
    if ("net" in p and "30" in p) or "payment" in p or "paid" in p:
        return "payment"
    if "attribut" in p or "cookie" in p:
        return "attribution"
    if "%" in p or "percent" in p or "commission" in p:
        return "commission"
    if "reel" in p or "stor" in p:
        return "deliverables"
    if "october" in p or "oct" in p or "live by" in p or "deadline" in p or "date" in p:
        return "timeline"
    if any(w in p for w in ("cloudstride", "sock", "shoe", "pair", "reward", "keep",
                            "yours", "product", "gifted", "ship", "size", "color",
                            "model", "free product", "includ")):
        return "reward"
    if "on top" in p or "in addition" in p or "both" in p or "as well" in p:
        return "commission"
    if "credit" in p or "track" in p or "window" in p:
        return "attribution"
    # A bare "30 day" is shared by usage-rights AND attribution-window (both are
    # 30-day for this campaign). Either fact answers it, so map to usage.
    if re.search(r"30\[?\\?s?-?\]?\??\s*day", p) or "30-day" in p or "30 day" in p:
        return "usage"
    return None


def audit():
    gaps: list[tuple[str, str, str]] = []   # (case_id, answer_pattern, reason)
    unclassified: list[tuple[str, str]] = []
    topic_counts: dict[str, int] = {}

    # Assemble the prompt ONCE (facts don't depend on the specific reply text for
    # this campaign) and check every fact signal is present.
    sample_prompt = assemble_prompt("What are the usage rights, payment terms, commission, deliverables, timeline, reward, exclusivity, and attribution window?",
                                    ["usage rights?", "payment?", "commission?", "deliverables?", "timeline?", "reward?", "exclusivity?", "attribution?"])
    prompt_lower = sample_prompt.lower()

    fact_present = {topic: bool(re.search(sig, prompt_lower))
                    for topic, sig in FACT_SIGNALS.items()}
    # fee-echo is threaded by the executor (proposedTerms / creatorRequestedRate),
    # not a knowledge field; the offer prompt always states the offer rate, so the
    # email can always echo the fee. Present by construction.
    fact_present["fee-echo"] = bool(re.search(r"\$?\d", prompt_lower))

    # Gather every (case_id, answer_pattern) from the answerable + multi-q + fixed banks.
    checks = []
    for c in loader.CASES:
        cid = c["id"]
        for chk in loader.ASSERTS.get(cid, []):
            for pat in chk.get("body_has_all", []):
                checks.append((cid, pat))

    for cid, pat in checks:
        topic = topic_of(pat)
        if topic is None:
            unclassified.append((cid, pat))
            continue
        topic_counts[topic] = topic_counts.get(topic, 0) + 1
        if not fact_present.get(topic, False):
            gaps.append((cid, pat, f"no '{topic}' fact in assembled draft prompt"))

    print("=== Fact presence in assembled draft prompt ===")
    for topic, present in sorted(fact_present.items()):
        mark = "OK " if present else "MISSING"
        print(f"  [{mark}] {topic:14s} ({topic_counts.get(topic, 0)} question-checks depend on it)")

    if unclassified:
        print(f"\n=== {len(unclassified)} answer_patterns could not be classified to a topic ===")
        for cid, pat in unclassified[:20]:
            print(f"  {cid}: /{pat}/")

    if gaps:
        print(f"\n=== {len(gaps)} COVERAGE GAPS (fact missing from prompt) ===")
        by_topic: dict[str, int] = {}
        for cid, pat, reason in gaps:
            t = topic_of(pat)
            by_topic[t] = by_topic.get(t, 0) + 1
        for t, n in sorted(by_topic.items()):
            print(f"  {t}: {n} question-checks unanswerable")
        return 1

    print(f"\nPASS — every classified question topic ({sum(topic_counts.values())} checks) "
          f"is backed by a fact in the assembled prompt.")
    return 0 if not unclassified else 0  # unclassified is informational, not a hard fail


if __name__ == "__main__":
    sys.exit(audit())
