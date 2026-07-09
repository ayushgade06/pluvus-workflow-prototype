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
import type {
  ClassifyResult,
  BrandDecisionClassifyResult,
  NegotiateResult,
  EmailDraft,
  PriorNegotiationContext,
} from "./types.js";
import { mapReplyIntentToBrandDecision } from "./brandDecisionParse.js";

// ---------------------------------------------------------------------------
// Default AI-provider mode (C1)
// ---------------------------------------------------------------------------
// The classification and negotiation providers previously defaulted to `mock`,
// which meant a process started WITHOUT the provider env vars (a misconfigured
// deploy, or `npm start` with no .env) silently ran ZERO LLM logic on a money
// path — MockNegotiationProvider fabricates rates from a hardcoded base and
// MockClassificationProvider is keyword-only with no injection/rate/opt-out
// parity. That is a production hazard, not a safe fallback.
//
// New default is env-aware:
//   * Under NODE_ENV=test  → `mock` (unit tests and CI stay hermetic; no network).
//   * Otherwise            → `langgraph` (real deploys use the real agent),
//                            and if a real run ever DOES fall back to mock we log
//                            a loud warning so the misconfiguration is visible.
//
// Test harnesses (engine/classification/negotiation/webhooks) construct
// Mock*Provider instances DIRECTLY and do not depend on this default, so the
// flip does not affect them.
function isTestEnv(): boolean {
  return (process.env["NODE_ENV"] ?? "").toLowerCase() === "test";
}

/**
 * Resolve the effective AI-provider mode from an explicit env value and the
 * NODE_ENV. Pure so it can be unit-tested without touching process.env.
 *
 *   explicit "langgraph" | "mock"  → used as-is (case-insensitive).
 *   explicit unknown / unset       → default: "mock" under NODE_ENV=test,
 *                                    "langgraph" otherwise.
 */
export function resolveAgentMode(
  explicit: string | undefined,
  nodeEnv: string | undefined,
): "mock" | "langgraph" {
  const e = (explicit ?? "").toLowerCase();
  if (e === "langgraph" || e === "mock") return e;
  return (nodeEnv ?? "").toLowerCase() === "test" ? "mock" : "langgraph";
}

function defaultAgentMode(): "mock" | "langgraph" {
  return isTestEnv() ? "mock" : "langgraph";
}

// Warn (once per kind) when a REAL (non-test) run resolves to the mock AI
// provider — either explicitly or by default. This is almost always a
// misconfiguration: the LLM is not being used at all.
const _mockFallbackWarned = new Set<string>();
function warnIfProdMock(kind: string, choice: string): void {
  if (choice === "mock" && !isTestEnv() && !_mockFallbackWarned.has(kind)) {
    _mockFallbackWarned.add(kind);
    console.warn(
      `[providerFactory] WARNING: ${kind} is running in MOCK mode outside NODE_ENV=test — ` +
        `no LLM is used for this path (rates/intents are rule-based). Set ${kind}=langgraph ` +
        `(and AGENT_SERVICE_URL) for real AI behavior.`,
    );
  }
}

// Warn when an explicit provider env var is set to something we don't recognize
// (a typo like "langraph"). resolveAgentMode() then applies the env-aware
// default; surfacing the typo avoids a silent fallback.
function warnUnknownProvider(kind: string, raw: string | undefined): void {
  if (raw === undefined) return;
  const v = raw.toLowerCase();
  if (v !== "langgraph" && v !== "mock") {
    console.warn(
      `[providerFactory] unknown ${kind}="${raw}" — using the ${defaultAgentMode()} default`,
    );
  }
}

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
  const raw = process.env["AGENT_PROVIDER"];
  const mode = resolveAgentMode(raw, process.env["NODE_ENV"]);
  warnUnknownProvider("AGENT_PROVIDER", raw);

  if (mode === "langgraph") {
    return new LangGraphClassificationProvider();
  }
  warnIfProdMock("AGENT_PROVIDER", "mock");
  return new MockClassificationProvider();
}

// ---------------------------------------------------------------------------
// Negotiation provider factory
// ---------------------------------------------------------------------------
//   NEGOTIATION_PROVIDER=mock       (default) → MockNegotiationProvider
//   NEGOTIATION_PROVIDER=langgraph            → LangGraphNegotiationProvider (HTTP to agent service)

export function negotiationProvider(): NegotiationProvider {
  const raw = process.env["NEGOTIATION_PROVIDER"];
  const mode = resolveAgentMode(raw, process.env["NODE_ENV"]);
  warnUnknownProvider("NEGOTIATION_PROVIDER", raw);

  if (mode === "langgraph") {
    return new LangGraphNegotiationProvider();
  }
  warnIfProdMock("NEGOTIATION_PROVIDER", "mock");
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

  async classifyBrandDecision(body: string): Promise<BrandDecisionClassifyResult> {
    // The deterministic token scan (brandDecisionParse) has already run and found
    // no explicit cue; this is the AI fallback (§2.4). We reuse the SAME reply
    // classifier — and thus the same circuit-breaker/degradation guarantees — and
    // map its reply intent onto a brand-decision action:
    //   POSITIVE            → APPROVE  (the brand is affirming / moving forward)
    //   QUESTION            → AMBIGUOUS (MED-N1) — a brand asking a QUESTION has
    //                         NOT approved. Mapping QUESTION→APPROVE meant a brand
    //                         asking "what's their reach?" auto-approved an
    //                         over-ceiling spend. It now re-asks instead.
    //   NEGATIVE / OPT_OUT  → REJECT
    //   UNKNOWN             → AMBIGUOUS (re-ask, never guess a money decision)
    // A counter AMOUNT can't come from this closed intent set, so a free-text
    // "counter to 400" with no COUNTER token surfaces as AMBIGUOUS here and is
    // clarified on the re-ask. When the agent is DOWN, classify() itself degrades
    // to UNKNOWN/0, which maps to AMBIGUOUS — so a degraded agent yields a re-ask,
    // not a fabricated approval.
    try {
      const result = await this.classifier.classify({ message: body });
      // Pure intent→action mapping (MED-N1: QUESTION→AMBIGUOUS, not APPROVE).
      return mapReplyIntentToBrandDecision(result.intent, result.confidence);
    } catch (err) {
      console.error(
        `[agentProvider] classifyBrandDecision failed, degrading to AMBIGUOUS (re-ask): ${errMessage(err)}`,
      );
      return { decision: "AMBIGUOUS", confidence: 0 };
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
      // Comprehension threaded from /negotiate so the SENT email answers an
      // explicit checklist and acknowledges pushed fixed terms (spec §6.2).
      creatorQuestions?: string[];
      pushedFixedTerms?: string[];
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
      rewardDescription:
        typeof config["rewardDescription"] === "string" ? config["rewardDescription"] : undefined,
      round: extra?.round,
      proposedTerms: extra?.proposedTerms,
      creatorReply: extra?.creatorReply,
      creatorRequestedRate: extra?.creatorRequestedRate,
      dealDescription: extra?.dealDescription,
      // Comprehension forwarded to /draft (spec §5.5/§6.2). The Python
      // DraftRequest reads these to render the question checklist + fixed-term
      // acknowledgement instead of re-parsing the raw reply.
      creatorQuestions: extra?.creatorQuestions,
      pushedFixedTerms: extra?.pushedFixedTerms,
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
