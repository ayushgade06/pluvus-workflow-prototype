import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { listEventsByInstance, listMessagesByInstance } from "../../db/index.js";
import { sendOnce } from "./idempotentSend.js";
import { resolveAgreedFee } from "./rewardSetup.js";
import { renderRateFixedEmail } from "./rateFixedEmail.js";

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

// Signals that the reply is trying to RE-OPEN the price rather than agree, even
// when it also contains an affirmative word ("yes, but can you do $600?"). If any
// of these appear, the deterministic agreement fast-path is suppressed so the
// reply is NOT auto-confirmed at the old rate — it falls through to the "rate is
// fixed" auto-reply instead. Matched on the lower-cased reply.
const RENEGOTIATION_PATTERNS: RegExp[] = [
  /\$\s*\d/, // an explicit dollar amount ("$600", "$ 600")
  /\bcan\s+(?:you|we)\s+(?:do|go|make\s+it)\b/,
  /\bhow\s+about\b/,
  /\binstead\b/,
  /\bmore\s+than\b/,
  /\b(?:bump|raise|increase)\b/,
  /\bhigher\b/,
  /\bnegotiat/,
  /\bcounter\b/,
];

/** True when the reply appears to re-open the fee (a counter, not an agreement). */
export function looksLikeRenegotiation(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return RENEGOTIATION_PATTERNS.some((re) => re.test(lower));
}

/** True when the reply text explicitly agrees, by deterministic phrase match.
 *  A reply that also tries to re-open the fee (see looksLikeRenegotiation) is
 *  NOT treated as a deterministic agreement, so "yes, but $600?" no longer
 *  silently confirms the deal at the already-agreed rate. */
export function isDeterministicAgreement(text: string | undefined): boolean {
  if (!text) return false;
  if (looksLikeRenegotiation(text)) return false;
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
  // A reply that tries to re-open the fee is never a confirmation, even if the
  // classifier reads its affirmative tone as POSITIVE ("yes, but can you do
  // $600?"). Flag it explicitly so the caller sends the "rate is fixed" reply.
  if (looksLikeRenegotiation(text)) {
    return { confirmed: false, intent: "RENEGOTIATION", confidence: 1 };
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
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;
  const config = node.config;

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

  // Not a confirmation. The deal is already closed at a fixed fee, so there is no
  // further negotiation here — send a polite deterministic auto-reply stating the
  // rate is finalized and redirecting the creator to the one action left at this
  // stage: confirm the agreement (or ask brief questions). Stay in REWARD_PENDING.
  //
  // The send is keyed on the inbound message id (unique per reply) so a creator
  // who emails several times each gets a response — not just the first — and a
  // worker retry of THIS reply never double-sends.
  const negotiationConfig =
    nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
  const events = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });
  const agreedFee = resolveAgreedFee(events, negotiationConfig, config);
  const brandName =
    typeof config["brandName"] === "string" ? (config["brandName"] as string) : "your brand";
  const senderName =
    typeof config["senderName"] === "string" ? (config["senderName"] as string) : brandName;

  const autoReply = renderRateFixedEmail("reward", {
    creatorName: creator.name,
    brandName,
    senderName,
    agreedFee,
  });
  const replyKey = latestInbound
    ? `reward:rate-fixed:${instance.id}:${latestInbound.id}`
    : `reward:rate-fixed:${instance.id}`;
  await sendOnce(email, instance.id, creator, autoReply, replyKey);

  return {
    nextState: "REWARD_PENDING",
    nextNodeId: node.id,
    eventType: "REWARD_REPLY_UNCONFIRMED",
    eventPayload: {
      intent,
      confidence,
      rateFixedReplySent: true,
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
