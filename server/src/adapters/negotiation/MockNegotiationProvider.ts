import type { NegotiationProvider } from "./NegotiationProvider.js";
import type {
  NegotiationRequest,
  NegotiationResponse,
  NegotiationAction,
  DraftRequest,
  DraftResponse,
  NegotiationTerm,
} from "./types.js";

// ---------------------------------------------------------------------------
// MockNegotiationProvider
// ---------------------------------------------------------------------------
// Deterministic rule-based negotiation. No LLM required.
// Used when NEGOTIATION_PROVIDER=mock (default) or when the agent service is
// unreachable. Behaviour is configured via constructor options so harness
// scenarios can force specific outcomes.

export interface MockNegotiationOptions {
  // Force a specific action regardless of input. When undefined, rules apply.
  forceAction?: NegotiationAction;
  // Counter until this round, then accept. Ignored when forceAction is set.
  counterUntilRound?: number;
}

function withinRange(rate: number, floor: NegotiationTerm, ceiling: NegotiationTerm): boolean {
  const lo = typeof floor["rate"] === "number" ? floor["rate"] : 0;
  const hi = typeof ceiling["rate"] === "number" ? ceiling["rate"] : Infinity;
  return rate >= lo && rate <= hi;
}

export class MockNegotiationProvider implements NegotiationProvider {
  private readonly forceAction: NegotiationAction | undefined;
  private readonly counterUntilRound: number;

  constructor(opts: MockNegotiationOptions = {}) {
    this.forceAction = opts.forceAction;
    this.counterUntilRound = opts.counterUntilRound ?? 0;
  }

  async negotiate(req: NegotiationRequest): Promise<NegotiationResponse> {
    const { round, maxRounds, campaignConstraints } = req;

    // Hard stop — never exceed maxRounds.
    if (round >= maxRounds) {
      return {
        action: "REJECT",
        reasoning: `Max rounds (${maxRounds}) reached — terminating negotiation`,
      };
    }

    if (this.forceAction !== undefined) {
      return this._buildResponse(this.forceAction, round, campaignConstraints.termFloor);
    }

    // Check if the creator's reply contains unreasonable terms (above ceiling).
    const ceilingRate = typeof campaignConstraints.termCeiling["rate"] === "number"
      ? campaignConstraints.termCeiling["rate"]
      : Infinity;

    const replyUpper = this._extractRate(req.creatorReply);
    if (replyUpper !== null && replyUpper > ceilingRate) {
      return {
        action: "ESCALATE",
        reasoning: `Creator demands $${replyUpper} which exceeds ceiling $${ceilingRate}`,
        proposedTerms: req.currentOffer,
      };
    }

    if (round < this.counterUntilRound) {
      return this._buildResponse("COUNTER", round, campaignConstraints.termFloor);
    }

    return this._buildResponse("ACCEPT", round, campaignConstraints.termFloor);
  }

  private _extractRate(text: string): number | null {
    const match = text.match(/\$\s*(\d[\d,]*)/);
    if (!match) return null;
    return parseInt(match[1]!.replace(/,/g, ""), 10);
  }

  private _buildResponse(
    action: NegotiationAction,
    round: number,
    currentOffer: NegotiationTerm,
  ): NegotiationResponse {
    switch (action) {
      case "ACCEPT":
        return {
          action: "ACCEPT",
          proposedTerms: currentOffer,
          responseDraft: `We're pleased to confirm the collaboration. Welcome aboard! Our team will follow up with the formal agreement.`,
          reasoning: "Terms are acceptable",
        };
      case "COUNTER":
        return {
          action: "COUNTER",
          proposedTerms: { ...currentOffer, rate: (currentOffer["rate"] as number ?? 1000) + 100 * (round + 1) },
          responseDraft: `Thank you for your interest! We'd like to propose a slightly adjusted rate for round ${round + 1}. Here's our counter-offer.`,
          reasoning: `Counter-offer round ${round + 1}`,
        };
      case "REJECT":
        return {
          action: "REJECT",
          reasoning: "Unable to reach mutually agreeable terms",
          responseDraft: `Thank you for considering the partnership. Unfortunately we're unable to reach mutually agreeable terms at this time. We hope to work together in the future.`,
        };
      case "ESCALATE":
        return {
          action: "ESCALATE",
          reasoning: "Terms require human review",
        };
    }
  }

  async draft(req: DraftRequest): Promise<DraftResponse> {
    const name = req.creatorName;
    const platform = req.creatorPlatform ?? "social media";
    const sender = req.senderName ?? "Pluvus Partnerships";

    switch (req.purpose) {
      case "initial_outreach":
        return {
          subject: `Collaboration opportunity — ${name}`,
          body: [
            `Hi ${name},`,
            ``,
            `We've been following your ${platform} content and think you'd be a perfect fit for our upcoming campaign.`,
            ``,
            `${sender} works with top creators in your space, and we believe this partnership could be mutually beneficial.`,
            ``,
            `Would you be open to a quick conversation about the details?`,
            ``,
            `Best,`,
            `${sender}`,
          ].join("\n"),
        };

      case "follow_up": {
        const n = req.round ?? 1;
        return {
          subject: `Re: Collaboration opportunity — ${name}`,
          body: [
            `Hi ${name},`,
            ``,
            `Just following up on my previous message${n > 1 ? ` (follow-up #${n})` : ""} — still very interested in collaborating!`,
            ``,
            `We'd love to hear from you when you have a moment.`,
            ``,
            `Best,`,
            `${sender}`,
          ].join("\n"),
        };
      }

      case "counter_offer": {
        const rate = req.proposedTerms?.["rate"];
        return {
          subject: `Re: Partnership proposal — updated offer`,
          body: [
            `Hi ${name},`,
            ``,
            `Thank you for your response. We appreciate your consideration.`,
            ``,
            rate !== undefined
              ? `After reviewing your feedback, we'd like to propose a rate of $${rate} for this collaboration.`
              : `We'd like to revise our proposal based on your feedback.`,
            ``,
            `Please let us know if these terms work for you.`,
            ``,
            `Best,`,
            `${sender}`,
          ].join("\n"),
        };
      }

      case "acceptance":
        return {
          subject: `Partnership confirmed — welcome to the campaign!`,
          body: [
            `Hi ${name},`,
            ``,
            `Wonderful news — we're thrilled to confirm your participation in our campaign!`,
            ``,
            `Our team will be in touch shortly with the formal agreement and next steps.`,
            ``,
            `Welcome aboard!`,
            ``,
            `Best,`,
            `${sender}`,
          ].join("\n"),
        };
    }
  }
}
