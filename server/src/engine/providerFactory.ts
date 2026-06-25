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

class AgentProviderAdapter implements IAgentProvider {
  constructor(
    private readonly classifier: ClassificationProvider,
    private readonly negotiator: NegotiationProvider,
    private readonly mockOpts: MockAgentOptions,
  ) {}

  async classify(body: string): Promise<ClassifyResult> {
    const result = await this.classifier.classify({ message: body });
    return { intent: result.intent as ClassifyResult["intent"], confidence: result.confidence };
  }

  async negotiate(
    round: number,
    config: Record<string, unknown>,
    creatorReply = "",
    priorContext?: PriorNegotiationContext,
  ): Promise<NegotiateResult> {
    // FIX-1 history threading + FIX-2 current-offer tracking: the request is
    // built from the executor-assembled priorContext (not hardcoded []/floor).
    const resp = await this.negotiator.negotiate(
      buildNegotiationRequest(round, config, creatorReply, priorContext),
    );
    return mapNegotiationResponse(resp, round);
  }

  async draftEmail(
    purpose: "initial_outreach" | "follow_up" | "counter_offer" | "acceptance",
    creator: Creator,
    config: Record<string, unknown>,
    extra?: { round?: number; proposedTerms?: NegotiationTerm },
  ): Promise<EmailDraft | null> {
    return this.negotiator.draft({
      purpose,
      creatorName: creator.name,
      creatorPlatform: creator.platform ?? undefined,
      creatorNiche: creator.niche ?? undefined,
      senderName: typeof config["senderName"] === "string" ? config["senderName"] : undefined,
      round: extra?.round,
      proposedTerms: extra?.proposedTerms,
      campaignContext: config,
    });
  }
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
