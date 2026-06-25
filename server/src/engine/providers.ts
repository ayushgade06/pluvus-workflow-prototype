import type { Creator, ReplyIntent } from "@prisma/client";
import type {
  EmailDraft,
  ClassifyResult,
  NegotiateResult,
  NegotiateOutcome,
  PriorNegotiationContext,
} from "./types.js";
import { MockNegotiationProvider } from "../adapters/negotiation/MockNegotiationProvider.js";
import type { NegotiationTerm, NegotiationHistoryEntry } from "../adapters/negotiation/types.js";
import { resolveBand } from "./band.js";

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
  negotiate(
    round: number,
    config: Record<string, unknown>,
    creatorReply?: string,
    priorContext?: PriorNegotiationContext,
  ): Promise<NegotiateResult>;
  /**
   * Generate email copy via the draft agent.
   * Phase 8: executors call this instead of the raw template when
   * NEGOTIATION_PROVIDER=langgraph (or mock with richer copy).
   * Returns null to signal "use the template fallback" (so old harnesses work).
   */
  draftEmail(
    purpose: "initial_outreach" | "follow_up" | "counter_offer" | "acceptance" | "onboarding",
    creator: Creator,
    config: Record<string, unknown>,
    extra?: {
      round?: number;
      proposedTerms?: NegotiationTerm;
      creatorReply?: string;
      creatorRequestedRate?: number;
    },
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

  async negotiate(
    round: number,
    config: Record<string, unknown>,
    creatorReply = "",
    priorContext?: PriorNegotiationContext,
  ): Promise<NegotiateResult> {
    const resp = await this._negotiationProvider.negotiate(
      buildNegotiationRequest(round, config, creatorReply, priorContext),
    );
    return mapNegotiationResponse(resp, round);
  }

  async draftEmail(
    _purpose: "initial_outreach" | "follow_up" | "counter_offer" | "acceptance" | "onboarding",
    _creator: Creator,
    _config: Record<string, unknown>,
  ): Promise<EmailDraft | null> {
    // Mock returns null — executors fall back to IEmailProvider.draft() template.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared negotiation request/response mapping
// ---------------------------------------------------------------------------
// Both the mock bridge above and the AgentProviderAdapter (providerFactory.ts)
// translate the engine's (round, config, creatorReply, priorContext) call into a
// NegotiationRequest and map the NegotiationResponse back to a NegotiateResult.
// Centralising it here keeps history threading (FIX-1) and current-offer
// tracking (FIX-2) wired identically on both paths.

/**
 * Build a NegotiationRequest from the engine call.
 * `priorContext` is assembled by the executor (the state authority): its
 * `history` becomes `negotiationHistory` and its `currentOffer` becomes the
 * `currentOffer.rate`. When absent (legacy callers), history is empty and the
 * current offer falls back to the floor — preserving prior behavior.
 */
export function buildNegotiationRequest(
  round: number,
  config: Record<string, unknown>,
  creatorReply: string,
  priorContext?: PriorNegotiationContext,
) {
  const maxRounds = typeof config["maxRounds"] === "number" ? config["maxRounds"] : 5;
  // Resolve the band from EITHER termFloor/termCeiling (seed snapshots) or
  // minBudget/maxBudget (Workflow Builder UI + templates). Without this, a
  // UI-built workflow sent an empty band → floor 0 / ceiling +inf → the
  // accept/counter/escalate logic was inert (see resolveBand).
  const { termFloor, termCeiling } = resolveBand(config);
  const senderName = typeof config["senderName"] === "string" ? config["senderName"] : undefined;

  // FIX-2: thread the last offer we actually proposed; fall back to the floor
  // only when there is no prior offer (round 0 / no history).
  const currentOffer: NegotiationTerm =
    priorContext?.currentOffer !== undefined
      ? { ...termFloor, rate: priorContext.currentOffer }
      : termFloor;

  // FIX-1: thread real prior turns instead of a hardcoded empty array.
  const negotiationHistory: NegotiationHistoryEntry[] = (priorContext?.history ?? []).map((h) => ({
    round: h.round,
    action: h.action,
    ...(h.rate !== undefined ? { terms: { rate: h.rate } } : {}),
    ...(h.message !== undefined ? { message: h.message } : {}),
  }));

  return {
    creatorReply,
    currentOffer,
    round,
    maxRounds,
    negotiationHistory,
    campaignConstraints: { termFloor, termCeiling, ...(senderName ? { senderName } : {}) },
  };
}

/**
 * Map a NegotiationResponse to the engine's legacy NegotiateResult, surfacing
 * the proposed rate (FIX-2) so the executor can persist it and thread it back
 * next turn. ESCALATE maps to the "escalate" outcome (executor owns the
 * MANUAL_REVIEW transition).
 */
export function mapNegotiationResponse(
  resp: { action: NegotiateOutcome | string; proposedTerms?: NegotiationTerm; responseDraft?: string; reasoning?: string },
  round: number,
): NegotiateResult {
  const proposedRate =
    typeof resp.proposedTerms?.["rate"] === "number" ? (resp.proposedTerms["rate"] as number) : undefined;

  switch (resp.action) {
    case "ACCEPT":
      return {
        outcome: "accept",
        message: resp.responseDraft ?? "Partnership confirmed.",
        ...(proposedRate !== undefined ? { proposedRate } : {}),
      };
    case "COUNTER":
      return {
        outcome: "counter",
        message: resp.responseDraft ?? `Counter-offer for round ${round + 1}.`,
        ...(proposedRate !== undefined ? { proposedRate } : {}),
      };
    case "REJECT":
      return { outcome: "reject", message: resp.responseDraft ?? "Unable to reach agreement." };
    case "ESCALATE":
      return { outcome: "escalate", message: resp.reasoning ?? "Escalated for human review." };
    default:
      // Defensive: an unknown action escalates to a human rather than guessing.
      return { outcome: "escalate", message: resp.reasoning ?? "Unrecognized negotiation action." };
  }
}
