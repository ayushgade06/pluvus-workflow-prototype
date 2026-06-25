import type { Creator, ReplyIntent } from "@prisma/client";
import type { EmailDraft, ClassifyResult, NegotiateResult, NegotiateOutcome } from "./types.js";
import { MockNegotiationProvider } from "../adapters/negotiation/MockNegotiationProvider.js";
import type { NegotiationTerm } from "../adapters/negotiation/types.js";

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
    template: string,
    config: Record<string, unknown>,
  ): Promise<EmailDraft> {
    const senderName =
      typeof config["senderName"] === "string" ? config["senderName"] : "Pluvus Partnerships";
    const brandName =
      typeof config["brandName"] === "string" ? config["brandName"] : senderName;
    const platform =
      typeof creator.platform === "string" ? creator.platform : "social media";

    const subjectTemplate =
      typeof config["subjectTemplate"] === "string" ? config["subjectTemplate"] : "";

    const resolve = (s: string) =>
      s
        .replace(/\{\{creatorName\}\}/g, creator.name)
        .replace(/\{\{brandName\}\}/g, brandName)
        .replace(/\{\{senderName\}\}/g, senderName)
        .replace(/\{\{platform\}\}/g, platform)
        .replace(/\{\{niche\}\}/g, creator.niche ?? "your niche");

    // Use node config template when provided; fall back to generic body.
    const body = template.trim()
      ? resolve(template)
      : [
          `Hi ${creator.name},`,
          ``,
          `We've been following your ${platform} content and think you'd be a perfect fit for our upcoming campaign.`,
          ``,
          `${senderName} works with top creators in your space, and we believe this partnership could be mutually beneficial.`,
          ``,
          `Would you be open to a quick conversation about the details?`,
          ``,
          `Best,`,
          `${senderName}`,
        ].join("\n");

    const subject = subjectTemplate.trim()
      ? resolve(subjectTemplate)
      : `Collaboration opportunity — ${creator.name}`;

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
  negotiate(round: number, config: Record<string, unknown>, creatorReply?: string): Promise<NegotiateResult>;
  /**
   * Generate email copy via the draft agent.
   * Phase 8: executors call this instead of the raw template when
   * NEGOTIATION_PROVIDER=langgraph (or mock with richer copy).
   * Returns null to signal "use the template fallback" (so old harnesses work).
   */
  draftEmail(
    purpose: "initial_outreach" | "follow_up" | "counter_offer" | "acceptance",
    creator: Creator,
    config: Record<string, unknown>,
    extra?: { round?: number; proposedTerms?: NegotiationTerm },
  ): Promise<EmailDraft | null>;
}

// ---------------------------------------------------------------------------
// MockAgentOptions
// ---------------------------------------------------------------------------

export interface MockAgentOptions {
  replyIntent?: ReplyIntent;
  negotiationOutcome?: NegotiateOutcome;
  negotiationCounterUntilRound?: number;
}

// ---------------------------------------------------------------------------
// MockAgentProvider
// ---------------------------------------------------------------------------

export class MockAgentProvider implements IAgentProvider {
  private readonly replyIntent: ReplyIntent;
  private readonly negotiationOutcome: NegotiateOutcome;
  private readonly negotiationCounterUntilRound: number;
  private readonly _negotiationProvider: MockNegotiationProvider;

  constructor(opts: MockAgentOptions = {}) {
    this.replyIntent = opts.replyIntent ?? "POSITIVE";
    this.negotiationOutcome = opts.negotiationOutcome ?? "accept";
    this.negotiationCounterUntilRound = opts.negotiationCounterUntilRound ?? 0;
    this._negotiationProvider = new MockNegotiationProvider({
      counterUntilRound: this.negotiationCounterUntilRound,
    });
  }

  async classify(_body: string, _intent?: string): Promise<ClassifyResult> {
    return {
      intent: this.replyIntent,
      confidence: 0.95,
    };
  }

  async negotiate(round: number, config: Record<string, unknown>, creatorReply = ""): Promise<NegotiateResult> {
    const maxRounds = typeof config["maxRounds"] === "number" ? config["maxRounds"] : 5;
    const termFloor = (config["termFloor"] ?? {}) as NegotiationTerm;
    const termCeiling = (config["termCeiling"] ?? {}) as NegotiationTerm;

    const resp = await this._negotiationProvider.negotiate({
      creatorReply,
      currentOffer: termFloor,
      round,
      maxRounds,
      negotiationHistory: [],
      campaignConstraints: { termFloor, termCeiling },
    });

    // Map NegotiationAction → legacy NegotiateOutcome for backwards compat.
    // ESCALATE is treated as reject in the legacy path (new executors use the
    // NegotiationProvider directly and handle ESCALATE → MANUAL_REVIEW).
    switch (resp.action) {
      case "ACCEPT":
        return { outcome: "accept", message: resp.responseDraft ?? "Partnership confirmed." };
      case "COUNTER":
        return {
          outcome: "counter",
          message: resp.responseDraft ?? `Counter-offer for round ${round + 1}.`,
        };
      case "REJECT":
        return { outcome: "reject", message: resp.responseDraft ?? "Unable to reach agreement." };
      case "ESCALATE":
        return { outcome: "escalate", message: resp.reasoning ?? "Escalated for human review." };
    }
  }

  async draftEmail(
    _purpose: "initial_outreach" | "follow_up" | "counter_offer" | "acceptance",
    _creator: Creator,
    _config: Record<string, unknown>,
  ): Promise<EmailDraft | null> {
    // Mock returns null — executors fall back to IEmailProvider.draft() template.
    return null;
  }
}
