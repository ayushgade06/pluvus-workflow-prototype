import type { Creator, ReplyIntent } from "@prisma/client";
import type { EmailDraft, ClassifyResult, NegotiateResult, NegotiateOutcome } from "./types.js";

// ---------------------------------------------------------------------------
// IEmailProvider
// ---------------------------------------------------------------------------

export interface IEmailProvider {
  draft(
    creator: Creator,
    template: string,
    config: Record<string, unknown>,
  ): Promise<EmailDraft>;
  send(
    draft: EmailDraft,
    creator: Creator,
  ): Promise<{ messageId: string; threadId: string }>;
}

// ---------------------------------------------------------------------------
// MockEmailProvider
// ---------------------------------------------------------------------------

export class MockEmailProvider implements IEmailProvider {
  async draft(
    creator: Creator,
    _template: string,
    config: Record<string, unknown>,
  ): Promise<EmailDraft> {
    const senderName =
      typeof config["senderName"] === "string" ? config["senderName"] : "Pluvus Partnerships";
    const platform =
      typeof creator.platform === "string" ? creator.platform : "social media";

    const subject = `Collaboration opportunity — ${creator.name}`;
    const body = [
      `Hi ${creator.name},`,
      ``,
      `We've been following your ${platform} content and think you'd be a perfect fit for our upcoming campaign.`,
      ``,
      `${senderName} works with top creators in your space, and we believe this partnership could be mutually beneficial.`,
      ``,
      `Would you be open to a quick conversation about the details? We'd love to share what we have in mind and hear your thoughts.`,
      ``,
      `Looking forward to connecting!`,
      ``,
      `Best,`,
      `${senderName}`,
    ].join("\n");

    return { subject, body };
  }

  async send(
    _draft: EmailDraft,
    creator: Creator,
  ): Promise<{ messageId: string; threadId: string }> {
    return {
      messageId: `mock-msg-${creator.id}-${Date.now()}`,
      threadId: `mock-thread-${creator.id}`,
    };
  }
}

// ---------------------------------------------------------------------------
// IAgentProvider
// ---------------------------------------------------------------------------

export interface IAgentProvider {
  classify(body: string, intent?: string): Promise<ClassifyResult>;
  negotiate(round: number, config: Record<string, unknown>): Promise<NegotiateResult>;
}

// ---------------------------------------------------------------------------
// MockAgentProvider
// ---------------------------------------------------------------------------

export interface MockAgentOptions {
  replyIntent?: ReplyIntent;
  negotiationOutcome?: NegotiateOutcome;
  negotiationCounterUntilRound?: number;
}

export class MockAgentProvider implements IAgentProvider {
  private readonly replyIntent: ReplyIntent;
  private readonly negotiationOutcome: NegotiateOutcome;
  private readonly negotiationCounterUntilRound: number;

  constructor(opts: MockAgentOptions = {}) {
    this.replyIntent = opts.replyIntent ?? "POSITIVE";
    this.negotiationOutcome = opts.negotiationOutcome ?? "accept";
    this.negotiationCounterUntilRound = opts.negotiationCounterUntilRound ?? 0;
  }

  async classify(_body: string, _intent?: string): Promise<ClassifyResult> {
    return {
      intent: this.replyIntent,
      confidence: 0.95,
    };
  }

  async negotiate(round: number, _config: Record<string, unknown>): Promise<NegotiateResult> {
    if (round < this.negotiationCounterUntilRound) {
      return {
        outcome: "counter",
        message: `Thank you for your interest! We'd like to propose a slightly adjusted rate that better aligns with our campaign budget. Here's our counter-offer for round ${round + 1}.`,
      };
    }

    switch (this.negotiationOutcome) {
      case "accept":
        return {
          outcome: "accept",
          message:
            "We're pleased to confirm the collaboration terms. Welcome to the campaign — our team will follow up with the formal agreement.",
        };
      case "reject":
        return {
          outcome: "reject",
          message:
            "Thank you for considering the partnership. Unfortunately we're unable to reach mutually agreeable terms at this time. We hope to work together in the future.",
        };
      case "counter":
        return {
          outcome: "counter",
          message: `We appreciate your continued engagement. Here's our revised offer for round ${round + 1}.`,
        };
    }
  }
}
