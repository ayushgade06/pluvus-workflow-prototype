import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { listMessagesByInstance } from "../../db/index.js";

// ---------------------------------------------------------------------------
// Reward Setup reply handling
// ---------------------------------------------------------------------------
// While an instance sits in REWARD_PENDING (Reward Setup waiting on the creator
// to confirm the agreement), an inbound reply is routed HERE — not through the
// first-reply classifier / negotiation path. There is deliberately no additional
// AI negotiation at this stage: a positive/agreement reply confirms the deal and
// advances to REWARD_CONFIRMED; anything else keeps the instance in REWARD_PENDING
// so a human or a later reply can still confirm.
//
// Detection reuses the existing classification agent (POSITIVE ⇒ confirm), with
// a deterministic fast-path for the explicit agreement phrases the confirmation
// email asks for ("I Agree", "confirmed", "looks good", "I accept", …). The
// deterministic layer guarantees those exact phrases confirm even under the
// keyword-based mock classifier, whose POSITIVE bucket doesn't list them all.

// Explicit agreement phrases. Matched as whole-ish tokens (word boundaries) on
// the lower-cased reply so "disagree" never matches "agree".
const AGREEMENT_PATTERNS: RegExp[] = [
  /\bi\s*agree\b/,
  /\bagreed\b/,
  /\bi\s*accept\b/,
  /\baccepted\b/,
  // "confirmed" (past tense = they confirmed) is an affirmation. A bare "confirm"
  // is deliberately NOT matched so questions like "how do I confirm?" or "before
  // I confirm" fall through to the classifier and stay pending.
  /\bconfirmed\b/,
  /\blooks?\s+good\b/,
  /\bsounds?\s+good\b/,
  /\blet'?s\s+do\s+it\b/,
  /\bthat\s+works\b/,
  /\bworks\s+for\s+me\b/,
  /^\s*yes\b/, // a leading "yes" (bare affirmative)
];

/** True when the reply text explicitly agrees, by deterministic phrase match. */
export function isDeterministicAgreement(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return AGREEMENT_PATTERNS.some((re) => re.test(lower));
}

/**
 * Decide whether a Reward Setup reply confirms the agreement.
 *
 * 1. Deterministic phrase match wins immediately (the phrases the email asked
 *    for). 2. Otherwise defer to the classification agent and treat POSITIVE as
 *    confirmation. Any other intent (question, negative, unknown) does NOT
 *    confirm — the instance stays in REWARD_PENDING.
 */
export async function isAgreementReply(
  text: string,
  agent: IAgentProvider,
): Promise<{ confirmed: boolean; intent: string; confidence: number }> {
  if (isDeterministicAgreement(text)) {
    return { confirmed: true, intent: "AGREEMENT", confidence: 1 };
  }
  const { intent, confidence } = await agent.classify(text);
  return { confirmed: intent === "POSITIVE", intent, confidence };
}

/**
 * Executor for an inbound reply received while in REWARD_PENDING. Reads the
 * latest inbound message, decides confirm vs. not, and returns the transition.
 *
 * The caller (runtime.handleRewardReply) is responsible for having persisted the
 * inbound Message row before invoking this — mirroring how executeReplyDetection
 * reads the message the inbound worker already stored.
 */
export async function executeRewardReply(
  ctx: ExecutionContext,
  _email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node } = ctx;

  if (instance.currentState !== "REWARD_PENDING") {
    throw new Error(
      `REWARD reply expects REWARD_PENDING state, got ${instance.currentState}`,
    );
  }

  const messages = await listMessagesByInstance(instance.id);
  const latestInbound = messages.filter((m) => m.direction === "INBOUND").at(-1);
  const body = latestInbound?.body ?? "";

  const { confirmed, intent, confidence } = await isAgreementReply(body, agent);

  if (confirmed) {
    return {
      nextState: "REWARD_CONFIRMED",
      // Expose the normal output connection: point at the next node (Payment
      // Info, once it exists). Null today since Reward Setup is the last node.
      nextNodeId: nextNodeAfter(ctx),
      completedAt: new Date(),
      eventType: "REWARD_CONFIRMED",
      eventPayload: {
        intent,
        confidence,
        ...(latestInbound ? { messageId: latestInbound.id } : {}),
      },
    };
  }

  // Not a confirmation (a question, a clarification, or an unclear reply). Stay
  // in REWARD_PENDING at the same node and keep waiting — no AI negotiation here.
  return {
    nextState: "REWARD_PENDING",
    nextNodeId: node.id,
    eventType: "REWARD_REPLY_UNCONFIRMED",
    eventPayload: {
      intent,
      confidence,
      ...(latestInbound ? { messageId: latestInbound.id } : {}),
    },
  };
}

// Resolve the node that follows Reward Setup in the graph, if any, so
// REWARD_CONFIRMED can carry the pointer for the future Payment Info node.
// Returns null when Reward Setup is the last node (the current linear graph).
function nextNodeAfter(ctx: ExecutionContext): string | null {
  const { node, nodeGraph } = ctx;
  const next = nodeGraph.find((n) => n.order === node.order + 1);
  return next?.id ?? null;
}
