"""The base campaign + brand/creator personas the sample conversations run on.

We use a HYBRID campaign (fixed fee + commission) because it produces the richest
copy — the emails must state a fee AND a fixed commission %, and creators can push
on either. The concrete brand/creator make the copy read realistically for the
founder rather than as lorem-ipsum.

The band is set to $300–$700 (founder's chosen size for these samples). The other
knobs follow the shipped hybrid workflow template
(server/src/templates/index.ts → hybridNodes → node-negotiation): maxRounds 4,
commissionRate 10, recommendedOfferPosition 0.0 (open at the floor and concede
up), overCeilingTolerance 0. With this band a fee ask inside 300–700 is
negotiable, an ask ABOVE 700 escalates over-ceiling, and an ask BELOW 300 is a
win we take at the creator's own cheaper number.

Everything the endpoints need is derived from CAMPAIGN so a reader can see, in one
place, exactly what the AI was told.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Brand + creator personas (concrete, so the copy reads like a real deal)
# ---------------------------------------------------------------------------

# The brand that set up the campaign. `sender_name` is what every email signs off
# as; `brand_description` is the "About <brand>" paragraph the outreach/offer
# prompts weave in. Deliberately a made-up running-shoe brand so nothing here
# collides with a real company.
BRAND_NAME = "Stridr"
SENDER_NAME = "Stridr Partnerships"
BRAND_DESCRIPTION = (
    "Stridr is a direct-to-consumer running-shoe brand built for everyday "
    "runners. Our flagship Tempo trainer uses a responsive foam midsole and a "
    "recycled-knit upper, and we sell exclusively through our own site with free "
    "returns."
)

# The creator we are negotiating with — a mid-tier fitness creator on Instagram.
CREATOR_NAME = "Maya Chen"
CREATOR_PLATFORM = "Instagram"
CREATOR_NICHE = "running & fitness"
CREATOR_EMAIL = "maya.chen.creator@example.com"


# ---------------------------------------------------------------------------
# Campaign constraints (the hybrid band + brand-supplied facts)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Campaign:
    """Everything the pipeline knows about this campaign.

    Split into the negotiation band (money invariants the agent is bounded by)
    and the brand-supplied facts (deliverables, timeline, knowledge fields) the
    copy may state — mirroring what the TS executor threads from the NEGOTIATION
    node config + the parent campaign record.
    """

    # -- identity / copy ----------------------------------------------------
    brand_name: str = BRAND_NAME
    sender_name: str = SENDER_NAME
    brand_description: str = BRAND_DESCRIPTION

    # -- negotiation band (founder-chosen $300–$700) ------------------------
    # min/max map to termFloor.rate / termCeiling.rate on the wire. commission is
    # FIXED (only the fee is negotiable). Band size chosen by the founder for these
    # samples; the other knobs follow server/src/templates/index.ts.
    min_budget: float = 300.0
    max_budget: float = 700.0
    max_rounds: int = 4
    commission_rate: float = 10.0
    recommended_offer_position: float = 0.0  # open at the floor, concede up
    over_ceiling_tolerance: float = 0.0

    # -- brand-supplied facts the copy may state as fact --------------------
    deliverables: str = (
        "1 Instagram Reel (30-60s) and 2 Instagram Stories featuring the Tempo trainer"
    )
    timeline: str = "content goes live the week of March 10"
    reward_description: str = "a free pair of the Tempo trainer in your size"

    # HARD-K1 knowledge fields — the terms creators most often ask about. Supplied
    # so the copy answers from real data instead of deferring/inventing. (Leave a
    # field blank to see the honest-defer behavior instead.)
    usage_rights: str = "we may reshare your content on our own channels for 90 days"
    exclusivity: str = "no category exclusivity — you're free to work with other brands"
    payment_terms: str = "net-30 after the content goes live"
    attribution_window: str = "30-day cookie attribution on your referral link"

    def deal_description(self) -> str:
        """Mirror server/src/engine/dealDescription.ts describeDeal() for a hybrid
        deal (commission present AND a fixed-fee budget). The number-free sentence
        the outreach + offer copy uses to explain WHAT KIND of deal this is."""
        c = int(self.commission_rate) if self.commission_rate == int(self.commission_rate) else self.commission_rate
        return (
            f"a hybrid partnership — you receive a fixed fee for your content, "
            f"PLUS a {c}% commission on the sales you drive. "
            f"(The exact fee is discussed once you reply.)"
        )

    # -- wire-shape helpers -------------------------------------------------

    def campaign_constraints(self) -> dict[str, Any]:
        """The `campaignConstraints` object exactly as the TS adapter builds it
        for NegotiateRequest (server/src/adapters/negotiation/types.ts). The agent
        computes floor/ceiling/recommended offer/tolerance from these."""
        return {
            "termFloor": {"rate": self.min_budget},
            "termCeiling": {"rate": self.max_budget},
            "senderName": self.sender_name,
            "brandDescription": self.brand_description,
            "deliverables": self.deliverables,
            "timeline": self.timeline,
            "commissionRate": self.commission_rate,
            "rewardDescription": self.reward_description,
            "usageRights": self.usage_rights,
            "exclusivity": self.exclusivity,
            "paymentTerms": self.payment_terms,
            "attributionWindow": self.attribution_window,
            "recommendedOfferPosition": self.recommended_offer_position,
            "overCeilingTolerance": self.over_ceiling_tolerance,
        }

    def draft_campaign_context(self) -> dict[str, Any]:
        """The `campaignContext` dict the executor threads into the REAL /draft. The
        draft prompts read the knowledge/commission/scope fields from here (and from
        the explicit DraftRequest fields, which we also set).

        Deliberately BAND-FREE — the AI copy must never see minBudget/maxBudget (the
        output guard blocks a floor/ceiling leak). The deterministic mock provider
        gets the band separately via `mock_campaign_context()`."""
        return {
            "brandName": self.brand_name,
            "brandDescription": self.brand_description,
            "commissionRate": self.commission_rate,
            "deliverables": self.deliverables,
            "timeline": self.timeline,
            "rewardDescription": self.reward_description,
            "usageRights": self.usage_rights,
            "exclusivity": self.exclusivity,
            "paymentTerms": self.payment_terms,
            "attributionWindow": self.attribution_window,
        }

    def mock_campaign_context(self) -> dict[str, Any]:
        """The `campaignContext` for the DETERMINISTIC (mock) draft path. Same as
        the AI context PLUS the band (minBudget/maxBudget) — the mock template copy
        cites the range ("$300–$700 + 10% commission"), which the AI path never
        does. This is the one deliberate difference between the two contexts."""
        ctx = self.draft_campaign_context()
        ctx["minBudget"] = self.min_budget
        ctx["maxBudget"] = self.max_budget
        return ctx


CAMPAIGN = Campaign()
