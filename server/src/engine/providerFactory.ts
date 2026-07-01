import type { Creator } from "@prisma/client";
import {
  MockEmailProvider,
  MockAgentProvider,
  buildNegotiationRequest,
  mapNegotiationResponse,
  type IEmailProvider,
  type IAgentProvider,
  type MockAgentOptions,
} from "./providers.js";
import { NylasEmailProvider } from "../providers/nylas/nylasEmailProvider.js";
import { LangGraphClassificationProvider } from "../adapters/classification/LangGraphClassificationProvider.js";
import { MockClassificationProvider } from "../adapters/classification/MockClassificationProvider.js";
import type { ClassificationProvider } from "../adapters/classification/ClassificationProvider.js";
import { LangGraphNegotiationProvider } from "../adapters/negotiation/LangGraphNegotiationProvider.js";
import { MockNegotiationProvider } from "../adapters/negotiation/MockNegotiationProvider.js";
import type { NegotiationProvider } from "../adapters/negotiation/NegotiationProvider.js";
import type { NegotiationTerm } from "../adapters/negotiation/types.js";
import type { ClassifyResult, NegotiateResult, EmailDraft, PriorNegotiationContext } from "./types.js";

// ---------------------------------------------------------------------------
// Email provider factory
// ---------------------------------------------------------------------------
//   EMAIL_PROVIDER=mock   (default) → MockEmailProvider
//   EMAIL_PROVIDER=nylas            → NylasEmailProvider (reads NYLAS_* env)

export function emailProvider(): IEmailProvider {
  const choice = (process.env["EMAIL_PROVIDER"] ?? "mock").toLowerCase();

  if (choice === "nylas") {
    return new NylasEmailProvider();
  }

  if (choice !== "mock") {
    console.warn(
      `[providerFactory] unknown EMAIL_PROVIDER="${choice}" — falling back to mock`,
    );
  }
  return new MockEmailProvider();
}

// ---------------------------------------------------------------------------
// Classification provider factory
// ---------------------------------------------------------------------------
//   AGENT_PROVIDER=mock       (default) → MockClassificationProvider (keyword-based)
//   AGENT_PROVIDER=langgraph            → LangGraphClassificationProvider (HTTP to agent service)

export function classificationProvider(): ClassificationProvider {
  const choice = (process.env["AGENT_PROVIDER"] ?? "mock").toLowerCase();

  if (choice === "langgraph") {
    return new LangGraphClassificationProvider();
  }

  if (choice !== "mock") {
    console.warn(
      `[providerFactory] unknown AGENT_PROVIDER="${choice}" — falling back to mock`,
    );
  }
  return new MockClassificationProvider();
}

// ---------------------------------------------------------------------------
// Negotiation provider factory
// ---------------------------------------------------------------------------
//   NEGOTIATION_PROVIDER=mock       (default) → MockNegotiationProvider
//   NEGOTIATION_PROVIDER=langgraph            → LangGraphNegotiationProvider (HTTP to agent service)

export function negotiationProvider(): NegotiationProvider {
  const choice = (process.env["NEGOTIATION_PROVIDER"] ?? "mock").toLowerCase();

  if (choice === "langgraph") {
    return new LangGraphNegotiationProvider();
  }

  if (choice !== "mock") {
    console.warn(
      `[providerFactory] unknown NEGOTIATION_PROVIDER="${choice}" — falling back to mock`,
    );
  }
  return new MockNegotiationProvider();
}

// ---------------------------------------------------------------------------
// Agent provider adapter
// ---------------------------------------------------------------------------
// Bridges the engine's IAgentProvider interface to the separate
// ClassificationProvider and NegotiationProvider abstractions.
// The negotiate() bridge maps NegotiationAction → legacy NegotiateResult so
// the engine's executor interface is unchanged.
//
// FIX-9 graceful degradation lives HERE (the orchestration seam), not inside the
// strict LangGraph providers — those keep their strict-validation "throw on
// malformed" behavior the audit praised. When the agent service is unreachable
// or the circuit breaker is open, an exception would otherwise propagate to the
// worker and strand the instance (classify → stuck at REPLY_RECEIVED; negotiate
// → BullMQ retry to exhaustion). Instead we degrade to the existing safe seams:
//   classify  → UNKNOWN / confidence 0  → low-confidence gate → MANUAL_REVIEW
//   negotiate → escalate                → executor            → MANUAL_REVIEW
//   draftEmail→ null                    → executor falls back to template copy
// so an agent outage becomes "route to a human", never "lose or strand".

export class AgentProviderAdapter implements IAgentProvider {
  // The real adapter generates LLM copy: a null from draftEmail() means
  // generation failed after retries, so offer/counter turns escalate to a human
  // rather than send fallback copy. (The MockNegotiationProvider.draft never
  // returns null — it produces template copy — so this only fires on a genuine
  // real-generation failure.)
  readonly generatesDraftCopy = true;

  constructor(
    private readonly classifier: ClassificationProvider,
    private readonly negotiator: NegotiationProvider,
    private readonly mockOpts: MockAgentOptions,
  ) {}

  async classify(body: string): Promise<ClassifyResult> {
    try {
      const result = await this.classifier.classify({ message: body });
      return { intent: result.intent as ClassifyResult["intent"], confidence: result.confidence };
    } catch (err) {
      // Degrade to UNKNOWN/0 — the low-confidence gate routes this to
      // MANUAL_REVIEW rather than stranding the instance at REPLY_RECEIVED.
      console.error(
        `[agentProvider] classify failed, degrading to UNKNOWN (MANUAL_REVIEW): ${errMessage(err)}`,
      );
      return { intent: "UNKNOWN", confidence: 0 };
    }
  }

  async negotiate(
    round: number,
    config: Record<string, unknown>,
    creatorReply = "",
    priorContext?: PriorNegotiationContext,
  ): Promise<NegotiateResult> {
    // FIX-1 history threading + FIX-2 current-offer tracking: the request is
    // built from the executor-assembled priorContext (not hardcoded []/floor).
    try {
      const resp = await this.negotiator.negotiate(
        buildNegotiationRequest(round, config, creatorReply, priorContext),
      );
      return mapNegotiationResponse(resp, round);
    } catch (err) {
      // Degrade to escalate — a money decision must never be guessed when the
      // agent is down. The executor maps escalate → MANUAL_REVIEW (human).
      console.error(
        `[agentProvider] negotiate failed, degrading to escalate (MANUAL_REVIEW): ${errMessage(err)}`,
      );
      return { outcome: "escalate", message: "" };
    }
  }

  async draftEmail(
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
  ): Promise<EmailDraft | null> {
    const request = {
      purpose,
      creatorName: creator.name,
      creatorPlatform: creator.platform ?? undefined,
      creatorNiche: creator.niche ?? undefined,
      senderName: typeof config["senderName"] === "string" ? config["senderName"] : undefined,
      brandDescription: typeof config["brandDescription"] === "string" ? config["brandDescription"] : undefined,
      deliverables: typeof config["deliverables"] === "string" ? config["deliverables"] : undefined,
      timeline: typeof config["timeline"] === "string" ? config["timeline"] : undefined,
      round: extra?.round,
      proposedTerms: extra?.proposedTerms,
      creatorReply: extra?.creatorReply,
      creatorRequestedRate: extra?.creatorRequestedRate,
      dealDescription: extra?.dealDescription,
      // Strip the internal price band before handing config to the copy
      // generator. The negotiation prompt is told to keep floor/ceiling
      // secret, but the draft endpoint was being handed the raw band
      // (minBudget/maxBudget/termFloor/termCeiling) in campaignContext and
      // writing it into the email (e.g. "in the $200-$500 range") — which the
      // output guard then blocks. The draft only ever needs the offer rate
      // (via proposedTerms), never the band. (Defense in depth: the output
      // guard remains the backstop if a model still emits a bound.)
      campaignContext: stripBandFromContext(config),
    };

    // Retry the draft call before degrading. A counter/offer email that fails
    // to generate must NOT silently fall back to the sparse negotiate
    // responseDraft (which explains only the fee and reads as a one-liner) — the
    // executor escalates to MANUAL_REVIEW on null. But the local LLM is often
    // just SLOW/transiently flaky, so we retry a couple of times first to keep
    // automation flowing on a blip instead of paging a human for it.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= DRAFT_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.negotiator.draft(request);
      } catch (err) {
        lastErr = err;
        console.error(
          `[agentProvider] draftEmail attempt ${attempt}/${DRAFT_MAX_ATTEMPTS} failed` +
            `${attempt < DRAFT_MAX_ATTEMPTS ? ", retrying" : ""}: ${errMessage(err)}`,
        );
      }
    }
    // Exhausted retries — degrade to null. Outreach/follow-up fall back to
    // template copy; the negotiation executor escalates the turn to a human so
    // no low-quality auto-copy reaches the creator.
    console.error(
      `[agentProvider] draftEmail failed after ${DRAFT_MAX_ATTEMPTS} attempts, degrading to null: ${errMessage(lastErr)}`,
    );
    return null;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// How many times to try the /draft copy generation before degrading to null.
// The local LLM is frequently slow/transiently flaky, so a retry usually
// succeeds on a blip; only a persistent failure degrades (→ escalation on the
// negotiation path).
const DRAFT_MAX_ATTEMPTS = 3;

// Keys carrying the internal price band. These must NOT reach the email copy
// generator — the email may reference only the agreed/offer rate (via
// proposedTerms), never the floor/ceiling band. Removing them at the draft seam
// stops the model from writing "$200-$500" into the body; the output guard is
// the backstop if a model invents a bound anyway.
const BAND_CONTEXT_KEYS = ["minBudget", "maxBudget", "termFloor", "termCeiling"] as const;

function stripBandFromContext(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...config };
  for (const k of BAND_CONTEXT_KEYS) delete safe[k];
  return safe;
}

/**
 * Agent (AI) provider.
 * Classification: AGENT_PROVIDER env flag (mock | langgraph).
 * Negotiation: NEGOTIATION_PROVIDER env flag (mock | langgraph).
 * Draft generation: via NegotiationProvider.draft().
 *
 * When mockIntent is set (harness / manual injection), the full MockAgentProvider
 * is returned so classification is bypassed and negotiation opts still apply.
 */
export function agentProvider(opts: MockAgentOptions = {}): IAgentProvider {
  if (opts.replyIntent !== undefined) {
    return new MockAgentProvider(opts);
  }
  return new AgentProviderAdapter(
    classificationProvider(),
    negotiationProvider(),
    opts,
  );
}
