import type { Creator, ReplyIntent } from "@prisma/client";
import type {
  EmailDraft,
  ClassifyResult,
  BrandDecisionClassifyResult,
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
    // Free-text product/sample reward blurb stamped from the campaign. Empty
    // when the campaign is cash-only, so {{rewardDescription}} resolves to "".
    const rewardDescription =
      typeof config["rewardDescription"] === "string" ? config["rewardDescription"] : "";

    const subjectTemplate =
      typeof config["subjectTemplate"] === "string" ? config["subjectTemplate"] : "";

    const resolve = (s: string) =>
      s
        .replace(/\{\{creatorName\}\}/g, creator.name)
        .replace(/\{\{brandName\}\}/g, brandName)
        .replace(/\{\{senderName\}\}/g, senderName)
        .replace(/\{\{platform\}\}/g, platform)
        .replace(/\{\{niche\}\}/g, creator.niche ?? "your niche")
        .replace(/\{\{rewardDescription\}\}/g, rewardDescription);

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
  /**
   * True when this provider actually GENERATES email copy via an LLM (the real
   * LangGraph adapter). When true, a null from draftEmail() means "generation
   * failed after retries" — offer/counter turns escalate to a human rather than
   * send lower-quality fallback copy. When false/absent (the mock), null just
   * means "no AI copy — use the template" and executors fall back as before, so
   * mock-mode dev and seeded harnesses keep working unchanged.
   */
  readonly generatesDraftCopy?: boolean;
  classify(body: string, intent?: string): Promise<ClassifyResult>;
  /**
   * AI fallback for parsing a brand's reply to an escalation email (§2.4), used
   * only when the deterministic token scan (brandDecisionParse) finds no cue.
   * Returns the parsed action + confidence (+ counter value when COUNTER). The
   * real adapter degrades to AMBIGUOUS/0 when the agent is down — a money
   * decision is never guessed on a degraded agent; the caller re-asks instead.
   */
  classifyBrandDecision(body: string): Promise<BrandDecisionClassifyResult>;
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
    purpose:
      | "initial_outreach"
      | "follow_up"
      | "counter_offer"
      | "acceptance"
      | "onboarding"
      | "reward_confirmation",
    creator: Creator,
    config: Record<string, unknown>,
    extra?: {
      round?: number;
      proposedTerms?: NegotiationTerm;
      creatorReply?: string;
      creatorRequestedRate?: number;
      dealDescription?: string;
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
  /** Drives MockAgentProvider.classifyBrandDecision for harnesses/tests. When
   *  absent the mock returns APPROVE (mirrors replyIntent defaulting to
   *  POSITIVE). Set decision: "AMBIGUOUS" to exercise the re-ask path. */
  brandDecision?: BrandDecisionClassifyResult;
}

// ---------------------------------------------------------------------------
// MockAgentProvider
// ---------------------------------------------------------------------------

export class MockAgentProvider implements IAgentProvider {
  // The mock does NOT generate LLM copy: draftEmail() returns null to mean "no AI
  // copy — use the template", so the negotiation executor keeps its template
  // fallback (rather than escalating) on this path.
  readonly generatesDraftCopy = false;
  private readonly replyIntent: ReplyIntent;
  private readonly negotiationOutcome: NegotiateOutcome;
  private readonly negotiationCounterUntilRound: number;
  private readonly brandDecision: BrandDecisionClassifyResult;
  private readonly _negotiationProvider: MockNegotiationProvider;

  constructor(opts: MockAgentOptions = {}) {
    this.replyIntent = opts.replyIntent ?? "POSITIVE";
    this.negotiationOutcome = opts.negotiationOutcome ?? "accept";
    this.negotiationCounterUntilRound = opts.negotiationCounterUntilRound ?? 0;
    this.brandDecision = opts.brandDecision ?? { decision: "APPROVE", confidence: 0.95 };
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

  async classifyBrandDecision(_body: string): Promise<BrandDecisionClassifyResult> {
    return this.brandDecision;
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
    _purpose:
      | "initial_outreach"
      | "follow_up"
      | "counter_offer"
      | "acceptance"
      | "onboarding"
      | "reward_confirmation",
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
  const brandDescription = typeof config["brandDescription"] === "string" ? config["brandDescription"] : undefined;
  const deliverables = typeof config["deliverables"] === "string" ? config["deliverables"] : undefined;
  const timeline = typeof config["timeline"] === "string" ? config["timeline"] : undefined;
  // Non-fee terms the creator cannot negotiate: the commission % and any product
  // perk/reward are brand-set. Threaded so the LLM can state them as FIXED when a
  // creator tries to move them (and so the output guard can enforce it). Only the
  // fixed fee is negotiable.
  const commissionRate =
    typeof config["commissionRate"] === "number" && Number.isFinite(config["commissionRate"])
      ? config["commissionRate"]
      : undefined;
  const rewardDescription =
    typeof config["rewardDescription"] === "string" && config["rewardDescription"].trim().length > 0
      ? config["rewardDescription"]
      : undefined;
  // M1: optional band position for the recommended opening offer (0..1). Passed
  // through only when a finite number; Python clamps + defaults to 0.5.
  const recommendedOfferPosition =
    typeof config["recommendedOfferPosition"] === "number" && Number.isFinite(config["recommendedOfferPosition"])
      ? config["recommendedOfferPosition"]
      : undefined;

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
    campaignConstraints: {
      termFloor,
      termCeiling,
      ...(senderName ? { senderName } : {}),
      ...(brandDescription ? { brandDescription } : {}),
      ...(deliverables ? { deliverables } : {}),
      ...(timeline ? { timeline } : {}),
      ...(commissionRate !== undefined ? { commissionRate } : {}),
      ...(rewardDescription ? { rewardDescription } : {}),
      ...(recommendedOfferPosition !== undefined ? { recommendedOfferPosition } : {}),
    },
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
    case "PRESENT_OFFER":
      return {
        outcome: "present_offer",
        message: resp.responseDraft ?? "Here are the details of our offer.",
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
