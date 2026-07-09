import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { listEventsByInstance, listMessagesByInstance } from "../../db/index.js";
import { sendOnce } from "./idempotentSend.js";
import { resolveAgreedFee } from "./rewardSetup.js";
import { renderRateFixedEmail } from "./rateFixedEmail.js";
import { nextNodeAfter } from "./graphNav.js";
import { extractReplyText } from "./replyText.js";
import { looksLikeOptOut } from "../../adapters/classification/classifierSpec.js";

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
// MED-N4 (per PRINCIPLES.md — LLM decides, code guards): whether a reply forms
// the contract is a COMPREHENSION decision, so it belongs to the classification
// agent (POSITIVE ⇒ confirm). The deterministic layer is narrowed to exactly two
// jobs code can own:
//   * an allowlist for the LITERAL "I Agree" the confirmation email requests —
//     the one phrase we explicitly asked for, so it must always confirm even
//     under the keyword mock;
//   * a renegotiation SUPPRESSION guard, which can only ever BLOCK confirmation
//     (never form it) — "yes, but can you do $600?" must not close at the old
//     rate no matter how affirmative the model reads it.
// The old broad phrase list ("looks good", "sounds good", a leading "yes", …)
// let a hedged "yes, assuming we can revisit X" form a contract by regex; those
// replies now go to the model, which reads the whole sentence.

// The ONE deterministic agreement phrase: the literal cue the confirmation email
// asks the creator to reply with. Word-bounded so "disagree" never matches.
const AGREEMENT_PATTERNS: RegExp[] = [/\bi\s*agree\b/];

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

/** True when the reply is the LITERAL "I Agree" the confirmation email asked
 *  for (MED-N4: the only phrase that confirms deterministically). A reply that
 *  also tries to re-open the fee (see looksLikeRenegotiation) is NOT treated as
 *  an agreement, so "I agree, but can you do $600?" never silently confirms the
 *  deal at the already-agreed rate. */
export function isDeterministicAgreement(text: string | undefined): boolean {
  if (!text) return false;
  if (looksLikeRenegotiation(text)) return false;
  const lower = text.toLowerCase();
  return AGREEMENT_PATTERNS.some((re) => re.test(lower));
}

/**
 * Decide whether a Reward Setup reply confirms the agreement (MED-N4).
 *
 * 1. The literal "I Agree" the email requested confirms deterministically.
 * 2. A renegotiation attempt never confirms (suppression guard — code may block
 *    contract formation, never form it).
 * 3. Everything else is a comprehension call: the classification agent decides,
 *    and POSITIVE ⇒ confirm. Any other intent (question, negative, unknown)
 *    does NOT confirm — the instance stays in REWARD_PENDING.
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
  // H1: decide on the creator's ACTUAL words, not the quoted thread/signature.
  const replyText = extractReplyText(body);

  // ── Deterministic opt-out gate (MED-W1) ───────────────────────────────────
  // An "unsubscribe" while awaiting the agreement confirmation must opt the
  // creator out — not get classified toward confirm/keep-waiting, and never
  // receive the "rate is fixed" auto-reply. Code, not a model call.
  if (looksLikeOptOut(replyText)) {
    return {
      nextState: "OPTED_OUT",
      nextNodeId: null,
      completedAt: new Date(),
      eventType: "REPLY_CLASSIFIED",
      eventPayload: {
        intent: "OPT_OUT",
        confidence: 1,
        deterministicOptOut: true,
        ...(latestInbound ? { messageId: latestInbound.id } : {}),
      },
    };
  }

  const { confirmed, intent, confidence } = await isAgreementReply(replyText, agent);

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

// HARD-A2: "next node in the linear graph" is shared (graphNav.ts) — Reward Setup
// and Payment Info had byte-identical copies. Returns null when Reward Setup is
// the last node, so REWARD_CONFIRMED carries the pointer to the next node (e.g.
// Payment Info) when one exists.
