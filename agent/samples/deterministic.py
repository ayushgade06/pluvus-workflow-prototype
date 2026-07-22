"""Deterministic (non-AI, template-only) provider — a faithful Python port of the
TS MockNegotiationProvider (server/src/adapters/negotiation/MockNegotiationProvider.ts).

This is the NON-AI half of the founder's request: it makes a rule-based
negotiation decision and renders fixed template copy at every step, with NO LLM
call — so the artifact can show the deterministic column beside the AI column,
for free. Ported verbatim from the mock so the copy matches what the system would
actually send when NEGOTIATION_PROVIDER=mock (the default / offline path).

`negotiate()` mirrors the mock rules:
  - round >= maxRounds        → REJECT
  - creator ask > ceiling     → ESCALATE
  - round < counterUntilRound → COUNTER (offer = currentOffer + 100*(round+1))
  - else                      → ACCEPT (at currentOffer)

`draft()` mirrors the mock's per-purpose template bodies. Unlike the real /draft,
the mock DOES cite the band range (e.g. "$300–$700 + 10% commission") in its copy,
so we thread minBudget/maxBudget here (the real AI path deliberately never sees the
band — the output guard would block a leak).
"""

from __future__ import annotations

import re
from typing import Any


class DeterministicProvider:
    """Rule-based negotiate + template draft. No network, no LLM, no cost."""

    def __init__(self, counter_until_round: int = 1) -> None:
        # Mock default is counterUntilRound=1 (counter on round 0, accept after).
        self.counter_until_round = counter_until_round

    # -- negotiate ----------------------------------------------------------

    @staticmethod
    def _extract_rate(text: str) -> int | None:
        """Mirror MockNegotiationProvider._extractRate — first "$<number>"."""
        m = re.search(r"\$\s*(\d[\d,]*)", text or "")
        if not m:
            return None
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            return None

    def negotiate(self, payload: dict[str, Any]) -> dict[str, Any]:
        round_ = payload["round"]
        max_rounds = payload["maxRounds"]
        cc = payload["campaignConstraints"]
        floor = cc["termFloor"]
        ceiling_rate = cc["termCeiling"].get("rate")
        current_offer = payload.get("currentOffer") or {"rate": floor.get("rate")}

        # Hard stop — never exceed maxRounds.
        if max_rounds > 0 and round_ >= max_rounds:
            return {
                "action": "REJECT",
                "reasoning": f"Max rounds ({max_rounds}) reached — terminating negotiation",
            }

        reply_upper = self._extract_rate(payload.get("creatorReply", ""))
        if reply_upper is not None and ceiling_rate is not None and reply_upper > ceiling_rate:
            return {
                "action": "ESCALATE",
                "reasoning": f"Creator demands ${reply_upper} which exceeds ceiling ${ceiling_rate}",
                "proposedTerms": current_offer,
            }

        if round_ < self.counter_until_round:
            return self._build(current_offer, "COUNTER", round_)
        return self._build(current_offer, "ACCEPT", round_)

    def _build(self, current_offer: dict[str, Any], action: str, round_: int) -> dict[str, Any]:
        if action == "ACCEPT":
            return {
                "action": "ACCEPT",
                "proposedTerms": current_offer,
                "responseDraft": (
                    "We're pleased to confirm the collaboration. Welcome aboard! Our "
                    "team will follow up with the formal agreement."
                ),
                "reasoning": "Terms are acceptable",
            }
        if action == "COUNTER":
            base = current_offer.get("rate")
            base = base if isinstance(base, (int, float)) else 1000
            return {
                "action": "COUNTER",
                "proposedTerms": {**current_offer, "rate": base + 100 * (round_ + 1)},
                "responseDraft": (
                    f"Thank you for your interest! We'd like to propose a slightly "
                    f"adjusted rate for round {round_ + 1}. Here's our counter-offer."
                ),
                "reasoning": f"Counter-offer round {round_ + 1}",
            }
        # PRESENT_OFFER / REJECT / ESCALATE are handled by negotiate() directly.
        return {"action": action, "reasoning": action}

    # -- draft (template copy per purpose) ----------------------------------

    def draft(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Port of MockNegotiationProvider.draft — fixed template per purpose."""
        name = payload["creatorName"]
        platform = payload.get("creatorPlatform") or "social media"
        niche = payload.get("creatorNiche") or "your niche"
        sender = payload.get("senderName") or "Pluvus Partnerships"
        ctx = payload.get("campaignContext") or {}
        brand = ctx.get("brandName") if isinstance(ctx.get("brandName"), str) else sender
        min_budget = ctx.get("minBudget") if isinstance(ctx.get("minBudget"), (int, float)) else None
        max_budget = ctx.get("maxBudget") if isinstance(ctx.get("maxBudget"), (int, float)) else None
        commission = ctx.get("commissionRate") if isinstance(ctx.get("commissionRate"), (int, float)) else None
        deliverables = _first_str(payload.get("deliverables"), ctx.get("deliverables"))
        timeline = _first_str(payload.get("timeline"), ctx.get("timeline"))
        reward = _first_str(payload.get("rewardDescription"), ctx.get("rewardDescription"))

        if min_budget is not None and max_budget is not None:
            budget_range = f"${_g(min_budget)}–${_g(max_budget)}"
        elif max_budget is not None:
            budget_range = f"up to ${_g(max_budget)}"
        else:
            budget_range = None

        purpose = payload["purpose"]
        proposed = (payload.get("proposedTerms") or {}).get("rate")

        if purpose == "initial_outreach":
            body = "\n".join(
                [
                    f"Hi {name},",
                    "",
                    f"We've been following your {platform} {niche} content and love what you're building.",
                    "",
                    f"{brand} is looking for creators like you for an upcoming campaign"
                    + (
                        f" — we're offering {budget_range}"
                        + (f" + {_g(commission)}% commission" if commission else "")
                        if budget_range
                        else ""
                    )
                    + ".",
                ]
                + ([f"", f"We'd also love to send you {reward} to feature."] if reward else [])
                + [
                    "",
                    "Would you be open to a quick conversation about the details?",
                    "",
                    "Best,",
                    f"{brand} Team",
                ]
            )
            return {"subject": f"{brand} partnership opportunity — {name}", "body": body}

        if purpose == "follow_up":
            n = payload.get("round") or 1
            body = "\n".join(
                [
                    f"Hi {name},",
                    "",
                    f"Just following up on our {brand} partnership offer" + (f" (note #{n})" if n > 1 else "") + ".",
                    "",
                    (
                        f"We have {budget_range} budgeted for the right creator in the {niche} space — we think that's you."
                        if budget_range
                        else "We'd love to hear from you when you have a moment."
                    ),
                ]
                + ([f"", f"You'd also receive {reward} as part of the collaboration."] if reward else [])
                + ["", "Best,", f"{brand} Team"]
            )
            return {"subject": f"Following up — {brand} partnership", "body": body}

        if purpose == "counter_offer":
            round_ = payload.get("round") or 1
            offer_amount = f"${_g(proposed)}" if proposed is not None else (budget_range or "a competitive fee")
            line = f"• Fee: {offer_amount}"
            if commission:
                line += f"\n• Commission: {_g(commission)}% on all sales driven by your content"
            if reward:
                line += f"\n• Reward: {reward}"
            body = "\n".join(
                [
                    f"Hi {name},",
                    "",
                    "Thanks for getting back to us! We've reviewed your request and here's our revised offer:",
                    "",
                    line,
                    "",
                    f"This is for a dedicated {platform} post showcasing {brand}. Our team handles the brief and creative direction — we just need your authentic voice.",
                    "",
                    (
                        "We're keen to make this work and hope we can reach an agreement. Please let us know your thoughts."
                        if round_ > 1
                        else "Let us know if this works for you or if you'd like to discuss further."
                    ),
                    "",
                    "Best,",
                    f"{brand} Team",
                ]
            )
            return {"subject": f"{brand} × {name} — updated offer", "body": body}

        if purpose == "acceptance":
            details = "\n".join(
                [
                    x
                    for x in [
                        f"• Compensation: {budget_range}" if budget_range else None,
                        f"• Commission: {_g(commission)}% on sales" if commission else None,
                        f"• Reward: {reward}" if reward else None,
                        f"• Platform: {platform}",
                    ]
                    if x
                ]
            )
            body = "\n".join(
                [
                    f"Hi {name},",
                    "",
                    f"Fantastic — we're thrilled to confirm your partnership with {brand}!",
                    "",
                    details,
                    "",
                    "Our team will reach out shortly with the campaign brief, content guidelines, and contract. Excited to work with you!",
                    "",
                    f"Welcome to the {brand} family,",
                    f"{brand} Partnerships Team",
                ]
            )
            return {"subject": f"You're in! {brand} × {name} partnership confirmed", "body": body}

        if purpose == "onboarding":
            rate_line = f"${_g(proposed)}" if proposed is not None else "the agreed rate"
            body = "\n".join(
                [
                    f"Hi {name},",
                    "",
                    f"Congratulations — we're delighted to officially welcome you to the {brand} partnership at a confirmed rate of {rate_line}!",
                    "",
                    "Here's what happens next to get you started:",
                    "• Agreement: we'll send a short partnership agreement for you to review and sign.",
                    "• Deliverables & timeline: we'll finalize the content and posting schedule together so it fits your workflow.",
                    f"• Payment: {rate_line} will be processed per the agreement once your deliverables are approved.",
                ]
                + ([f"• Reward: you'll receive {reward}."] if reward else [])
                + [
                    "",
                    "Reply to this email with any questions — we're here to help and excited to create something great together.",
                    "",
                    "Best,",
                    f"{sender}",
                ]
            )
            return {"subject": f"Welcome aboard! Next steps for your {brand} partnership", "body": body}

        # Fallback for any unported purpose.
        return {"subject": f"{brand} partnership — {name}", "body": f"Hi {name},\n\nBest,\n{sender}"}


def _first_str(*vals: Any) -> str | None:
    for v in vals:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _g(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)
