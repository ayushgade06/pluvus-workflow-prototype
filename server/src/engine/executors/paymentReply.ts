import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import {
  findPaymentInfoByInstance,
  listEventsByInstance,
  listMessagesByInstance,
} from "../../db/index.js";
import { sendOnce } from "./idempotentSend.js";
import { resolveAgreedFee } from "./rewardSetup.js";
import { paymentFormLink } from "./paymentEmail.js";
import { renderRateFixedEmail } from "./rateFixedEmail.js";
import { extractReplyText } from "./replyText.js";
import { looksLikeOptOut } from "../../adapters/classification/classifierSpec.js";

// ---------------------------------------------------------------------------
// Payment Info reply handling
// ---------------------------------------------------------------------------
// While an instance sits in PAYMENT_PENDING (Payment Info waiting on the creator
// to submit the hosted payout form), the expected creator action is a FORM
// SUBMISSION (routes/payment.ts → handlePaymentSubmission), not an email. But a
// creator may still EMAIL back at this stage — often trying to re-open the price.
//
// The deal is already closed at a fixed fee, so there is no negotiation here. An
// inbound email reply gets a polite deterministic auto-reply that: (1) states the
// agreed rate is finalized and cannot be changed, and (2) redirects the creator
// to the one action left — completing the payout form (link re-shared). The
// instance stays in PAYMENT_PENDING, still waiting on the form submission.
//
// This mirrors executeRewardReply's non-confirm branch. It never advances the
// state — a form submission (not an email) is what moves PAYMENT_PENDING forward.

export async function executePaymentReply(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;
  const config = node.config;

  if (instance.currentState !== "PAYMENT_PENDING") {
    throw new Error(
      `PAYMENT reply expects PAYMENT_PENDING state, got ${instance.currentState}`,
    );
  }

  const messages = await listMessagesByInstance(instance.id);
  const latestInbound = messages.filter((m) => m.direction === "INBOUND").at(-1);

  // ── Deterministic opt-out gate (MED-W1) ───────────────────────────────────
  // The old behavior auto-replied marketing copy ("the rate is fixed, here's
  // your payout link") to EVERY email at this stage — including "stop emailing
  // me", a CAN-SPAM violation. Honor an unambiguous opt-out first, on the
  // creator's actual words (quoted thread stripped). Code, not a model call.
  if (latestInbound && looksLikeOptOut(extractReplyText(latestInbound.body))) {
    return {
      nextState: "OPTED_OUT",
      nextNodeId: null,
      completedAt: new Date(),
      eventType: "REPLY_CLASSIFIED",
      eventPayload: {
        intent: "OPT_OUT",
        confidence: 1,
        deterministicOptOut: true,
        messageId: latestInbound.id,
      },
    };
  }

  // Resolve the agreed fee (to name the locked figure) and the existing payout
  // form link (to re-share). The PaymentInfo row was created when the payout
  // email was sent (executePaymentInfo), so its token resolves the same link.
  const negotiationConfig =
    nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
  const events = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });
  const agreedFee = resolveAgreedFee(events, negotiationConfig, config);

  const payment = await findPaymentInfoByInstance(instance.id);
  const formLink = payment ? paymentFormLink(payment.token) : undefined;
  const collectShippingAddress = config["shipsPhysicalProduct"] === true;

  const brandName =
    typeof config["brandName"] === "string" ? (config["brandName"] as string) : "your brand";
  const senderName =
    typeof config["senderName"] === "string" ? (config["senderName"] as string) : brandName;

  const autoReply = renderRateFixedEmail("payment", {
    creatorName: creator.name,
    brandName,
    senderName,
    agreedFee,
    formLink,
    collectShippingAddress,
  });

  // Key on the inbound message id (unique per reply) so repeated emails each get
  // a response and a worker retry of THIS reply never double-sends.
  const replyKey = latestInbound
    ? `payment:rate-fixed:${instance.id}:${latestInbound.id}`
    : `payment:rate-fixed:${instance.id}`;
  await sendOnce(email, instance.id, creator, autoReply, replyKey);

  // Stay in PAYMENT_PENDING at the same node — an email never advances the payout
  // step; only the form submission does.
  return {
    nextState: "PAYMENT_PENDING",
    nextNodeId: node.id,
    eventType: "PAYMENT_REPLY_UNRESOLVED",
    eventPayload: {
      rateFixedReplySent: true,
      ...(latestInbound ? { messageId: latestInbound.id } : {}),
    },
  };
}
