import type { JsonObject } from "../../db/schema.js";
import { isUniqueViolation } from "../../db/errors.js";
import {
  createPaymentInfo,
  findPaymentInfoByInstance,
  listEventsByInstance,
  updatePaymentTokenHash,
} from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { sendOnce } from "./idempotentSend.js";
import { renderPaymentRequestEmail, paymentFormLink } from "./paymentEmail.js";
import { mintPaymentToken } from "./paymentToken.js";
import { resolveBrandName } from "../campaignContext.js";
import { blockedByMissingBrand, blockedByAttributionMint } from "./guardEscalation.js";
import { nextNodeAfter } from "./graphNav.js";
import { resolvePartnership } from "./partnership.js";

// ---------------------------------------------------------------------------
// Payment Info executor
// ---------------------------------------------------------------------------
// Runs immediately after the creator confirms the agreement (state
// REWARD_CONFIRMED). Its single responsibility is to collect payout info:
//   1. Mint (or reuse) a secure token and persist a PaymentInfo row, so the
//      hosted form link resolves back to this instance.
//   2. Email the creator the "Payment Information Required" message with the
//      tokenized link to the hosted payout form.
//   3. Transition REWARD_CONFIRMED → PAYMENT_PENDING and WAIT there.
//
// It does NOT send payments, verify anything, or execute the next node. The
// creator's form submission is handled out-of-band by the hosted payment page
// (routes/payment.ts → runtime.handlePaymentSubmission), which stores the info
// and hands control back to the engine to advance to the next connected node.

/**
 * Recover the RAW payment token for an instance from the persisted
 * PAYMENT_INFO_SENT event payload (the durable carrier of the raw token — the DB
 * row stores only its hash, BUG-S1). Returns the newest event's token, or null
 * when no such event exists yet (the row was created but the step hasn't
 * committed its event). The event payload stamps `{ token, formLink }`.
 */
async function rawTokenFromEvent(instanceId: string): Promise<string | null> {
  const events = await listEventsByInstance(instanceId, { type: "PAYMENT_INFO_SENT" });
  // listEventsByInstance orders ascending by occurredAt; the last is newest.
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]?.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const t = (payload as Record<string, unknown>)["token"];
      if (typeof t === "string" && t) return t;
    }
  }
  return null;
}

/**
 * Resolve (or create) the PaymentInfo row for this instance and return the RAW
 * token used to build the hosted-form link. Idempotent.
 *
 * BUG-S1: the DB stores only sha256(token); the raw token is what the email link
 * needs. So:
 *   - No row yet → mint a fresh token, persist its HASH + expiry, return the RAW.
 *   - Row already exists (a BullMQ retry) → recover the RAW token from the
 *     persisted PAYMENT_INFO_SENT event so the retry reuses the SAME link the
 *     creator already received.
 *   - Row exists but no event carries the raw token yet (a crash between row
 *     create and event commit, before any email went out) → re-mint, update the
 *     row's hash + expiry, and return the fresh raw token. sendOnce still governs
 *     the single actual send, so this cannot double-email.
 */
export async function resolvePaymentToken(instanceId: string): Promise<string> {
  const existing = await findPaymentInfoByInstance(instanceId);
  if (existing) {
    const recovered = await rawTokenFromEvent(instanceId);
    if (recovered) return recovered;
    // No event yet → the previous attempt didn't get far enough to send a link.
    // Re-mint and rotate the stored hash so the link we send now is valid.
    const minted = mintPaymentToken();
    await updatePaymentTokenHash(instanceId, minted.tokenHash, minted.expiresAt);
    return minted.rawToken;
  }
  const minted = mintPaymentToken();
  try {
    await createPaymentInfo({
      instanceId,
      tokenHash: minted.tokenHash,
      expiresAt: minted.expiresAt,
    });
    return minted.rawToken;
  } catch (err) {
    // Another attempt created the row first (unique instanceId) — reuse its link.
    if (isUniqueViolation(err)) {
      const recovered = await rawTokenFromEvent(instanceId);
      if (recovered) return recovered;
      // The concurrent creator hasn't committed its event yet; rotate to a known
      // token so the caller has a valid link (sendOnce dedupes the email).
      const rotate = mintPaymentToken();
      await updatePaymentTokenHash(instanceId, rotate.tokenHash, rotate.expiresAt);
      return rotate.rawToken;
    }
    throw err;
  }
}

// HARD-A2: the "next node in the linear graph" resolver is shared (graphNav.ts);
// Payment Info and Reward Setup had byte-identical copies. It returns null when
// Payment Info is the last node, which the engine treats as terminal.

export async function executePaymentInfo(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, creator } = ctx;
  const config = node.config;

  if (instance.currentState !== "REWARD_CONFIRMED") {
    throw new Error(
      `PAYMENT_INFO expects REWARD_CONFIRMED state, got ${instance.currentState}`,
    );
  }

  // 1. Token + persistence — resolves the link back to creator/campaign/exec.
  const token = await resolvePaymentToken(instance.id);
  const formLink = paymentFormLink(token);

  // 2. Draft the deterministic "Payment Information Required" email. Brand names
  //    are stamped into node config (restampBrand). L4: resolve from config →
  //    campaign; if neither has a brand name, fail loud to MANUAL_REVIEW rather
  //    than email the creator "your brand".
  const brandName = resolveBrandName(config, ctx.campaign);
  if (brandName === undefined) {
    // L4 (#14): no resolvable brand name is a config problem for a human — route
    // to MANUAL_REVIEW (clean one-way handoff) rather than email the creator
    // "your brand". runtime emails the brand an FYI keyed on missing_brand_name.
    return blockedByMissingBrand(ctx.node.type);
  }
  const senderName =
    typeof config["senderName"] === "string" ? (config["senderName"] as string) : brandName;
  // Physical-product campaigns collect a shipping address on the same form, so
  // the request email tells the creator to expect it. Stamped by restampBrand.
  const collectShippingAddress = config["shipsPhysicalProduct"] === true;
  const draft = renderPaymentRequestEmail({
    creatorName: creator.name,
    brandName,
    senderName,
    formLink,
    collectShippingAddress,
  });

  // 3. Idempotent send keyed on (instance, payment_request) — a re-run of the
  //    REWARD_CONFIRMED auto-chain won't double-send the payout request.
  await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `payment:request:${instance.id}`,
    undefined, // deps — default
    undefined, // recipient — creator
    ctx.campaign?.name, // Gmail Campaign Labels (§6.3)
  );

  // Enter the waiting state. Stay on THIS node so the form submission is handled
  // by the payment path, and expose the normal output connection for later
  // (nextNodeId points at whatever node follows — Content Brief, once it exists).
  return {
    nextState: "PAYMENT_PENDING",
    nextNodeId: node.id,
    eventType: "PAYMENT_INFO_SENT",
    eventPayload: { token, formLink } as JsonObject,
  };
}

// ---------------------------------------------------------------------------
// Payment submission handling
// ---------------------------------------------------------------------------
// Runs when the creator has submitted the hosted payout form. The submission
// itself (validating + persisting the payout fields) is done by the payment
// route before this executor runs — mirroring how the inbound-email worker
// persists a Message before executeReplyDetection reads it. By the time this
// runs, the PaymentInfo row is already PAYMENT_RECEIVED; this executor just
// produces the state transition + output pointer so the engine resumes into the
// next connected node.

export async function executePaymentSubmission(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node } = ctx;

  if (instance.currentState !== "PAYMENT_PENDING") {
    throw new Error(
      `PAYMENT submission expects PAYMENT_PENDING state, got ${instance.currentState}`,
    );
  }

  const payment = await findPaymentInfoByInstance(instance.id);
  if (!payment || payment.status !== "PAYMENT_RECEIVED") {
    // Defensive: the route persists PAYMENT_RECEIVED before stepping, so this
    // should not happen. If it does, stay pending rather than advancing on
    // incomplete data.
    throw new Error(
      `PAYMENT submission for ${instance.id} has no received PaymentInfo row`,
    );
  }

  // Advance to the success state and expose the output connection. nextNodeId is
  // null today (Payment Info is the last node) → PAYMENT_RECEIVED is terminal, so
  // stamp completedAt. Once a Content Brief node follows, nextNodeId points at it
  // and the state is a hand-off rather than a completion.
  const nextNodeId = nextNodeAfter(ctx);

  // Phase 1: mint the Partnership + fee Obligation (the money ledger) when this is
  // the terminal node (no Content Brief follows). BUG-E2: if that mint fails
  // (throws, or resolvePartnership returns null on a DB blip), do NOT fall through
  // to the PAYMENT_RECEIVED terminal — a "completed" deal with no ledger row has
  // no recovery path (PAYMENT_RECEIVED-as-terminal here is a dead end for the mint;
  // only re-running the node recovers it). Route to MANUAL_REVIEW so a human can
  // re-run and complete the mint. The payout data is already persisted, so nothing
  // is lost. (A swallowed welcome-email failure inside resolvePartnership still
  // returns the partnership, so it does NOT trip this — only a real mint failure.)
  if (nextNodeId === null) {
    let partnership;
    try {
      partnership = await resolvePartnership(ctx, email);
    } catch (err) {
      console.error("[paymentInfo] resolvePartnership threw — escalating to MANUAL_REVIEW", err);
      return blockedByAttributionMint(node.type);
    }
    if (!partnership) {
      console.error(
        `[paymentInfo] resolvePartnership returned null for ${instance.id} — escalating to MANUAL_REVIEW`,
      );
      return blockedByAttributionMint(node.type);
    }
  }

  return {
    nextState: "PAYMENT_RECEIVED",
    nextNodeId,
    completedAt: nextNodeId === null ? new Date() : null,
    eventType: "PAYMENT_RECEIVED",
    eventPayload: {
      method: payment.method,
      country: payment.country ?? undefined,
    } as JsonObject,
  };
}
