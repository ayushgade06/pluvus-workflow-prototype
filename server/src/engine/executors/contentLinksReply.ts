import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { appendEvent } from "../../db/events.js";
import { listMessagesByInstance } from "../../db/index.js";
import { sendOnce } from "./idempotentSend.js";
import { extractReplyText } from "./replyText.js";
import { extractContentUrls } from "./extractUrls.js";
import { renderContentLinksNudgeEmail } from "./contentLinksNudgeEmail.js";
import { looksLikeOptOut } from "../../adapters/classification/classifierSpec.js";

// ---------------------------------------------------------------------------
// Content-links reply handling
// ---------------------------------------------------------------------------
// While an instance sits in CONTENT_LINKS_PENDING (the merged Content Brief node
// parked after the payout form, having asked the creator to reply in the thread
// with the link(s) to their published content), the expected creator action is a
// plain email reply carrying those links. This handler processes that reply. It
// mirrors executePaymentReply: a deterministic opt-out gate first, then a
// deterministic decision (NO model call) based on whether the reply contains URLs.
//
//   opt-out reply      → OPTED_OUT (never auto-reply; CAN-SPAM parity)
//   reply with URLs    → append a CONTENT_LINKS_SUBMITTED event carrying the
//                        extracted URLs, then escalate to MANUAL_REVIEW so a human
//                        operator reviews the content. NO payout/ledger side effect.
//   reply with no URLs → send ONE gentle nudge (idempotent per inbound message)
//                        and stay in CONTENT_LINKS_PENDING (self-loop).
//
// Escalation happens exactly once: once the instance reaches MANUAL_REVIEW
// (terminal), the inbound worker drops any further replies, so no additional
// CONTENT_LINKS_SUBMITTED events are ever appended.

export async function executeContentLinksReply(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, creator } = ctx;
  const config = node.config;

  if (instance.currentState !== "CONTENT_LINKS_PENDING") {
    throw new Error(
      `CONTENT_LINKS reply expects CONTENT_LINKS_PENDING state, got ${instance.currentState}`,
    );
  }

  const messages = await listMessagesByInstance(instance.id);
  const latestInbound = messages.filter((m) => m.direction === "INBOUND").at(-1);

  // The creator's actual reply text, with the quoted thread history stripped so
  // previously-sent links (ours) are not re-captured and the opt-out gate keys off
  // the creator's own words. Same de-quote seam the other reply handlers use.
  const replyText = latestInbound ? extractReplyText(latestInbound.body) : "";

  // ── Deterministic opt-out gate ────────────────────────────────────────────
  // An unsubscribe-style reply routes to OPTED_OUT and never receives an auto-
  // reply (CAN-SPAM parity with the other waiting states). Code, not a model call.
  // Precedence: honored even when the reply also contains URLs.
  if (latestInbound && looksLikeOptOut(replyText)) {
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

  // ── Deterministic URL extraction ──────────────────────────────────────────
  const urls = extractContentUrls(replyText);

  if (urls.length > 0) {
    // Append the durable CONTENT_LINKS_SUBMITTED event carrying the extracted
    // URLs. This is the append-only record the escalation + manual queue read
    // from. Appended directly (like partnership.ts appends PARTNERSHIP_ACTIVATED)
    // because a NodeResult carries only one domain event and the escalation event
    // (MANUAL_REVIEW_FLAGGED, below) must be the one that drives escalationReason.
    await appendEvent({
      instanceId: instance.id,
      type: "CONTENT_LINKS_SUBMITTED",
      nodeId: node.id,
      payload: {
        urls,
        linkCount: urls.length,
        ...(latestInbound ? { messageId: latestInbound.id } : {}),
      },
    });

    // Escalate to MANUAL_REVIEW through the existing escalation path. The reason
    // is objective — it states what happened without implying a judgment. stepInstance
    // fires notifyBrandOfEscalation on the fresh MANUAL_REVIEW transition using
    // this payload.reason. NO payout/obligation/ledger action is triggered here.
    return {
      nextState: "MANUAL_REVIEW",
      nextNodeId: null,
      completedAt: new Date(),
      eventType: "MANUAL_REVIEW_FLAGGED",
      eventPayload: {
        outcome: "ESCALATE",
        reason: "content_links_submitted",
        node: node.type,
        linkCount: urls.length,
        ...(latestInbound ? { messageId: latestInbound.id } : {}),
      },
    };
  }

  // ── No URLs — send a gentle idempotent nudge, keep waiting ────────────────
  const senderName =
    typeof config["senderName"] === "string" && (config["senderName"] as string).trim()
      ? (config["senderName"] as string)
      : typeof config["brandName"] === "string" && (config["brandName"] as string).trim()
        ? (config["brandName"] as string)
        : "the team";

  const nudge = renderContentLinksNudgeEmail({ creatorName: creator.name, senderName });

  // Key on the inbound message id (unique per reply) so a redelivered copy of the
  // SAME reply never double-sends, while a genuinely new no-URL reply gets its own
  // nudge. Falls back to an instance-scoped key when there is no inbound row.
  const nudgeKey = latestInbound
    ? `content-links:nudge:${instance.id}:${latestInbound.id}`
    : `content-links:nudge:${instance.id}`;
  await sendOnce(email, instance.id, creator, nudge, nudgeKey);

  // Stay in CONTENT_LINKS_PENDING at the same node — only a reply with links (or
  // an opt-out) advances the state. The self-loop carries CONTENT_LINKS_SUBMITTED
  // (the state's natural event — no new event type is introduced beyond the two the
  // spec defines) with linkCount 0 + nudgeSent, so downstream readers that surface
  // submitted URLs filter on urls.length > 0 and skip nudge rows.
  return {
    nextState: "CONTENT_LINKS_PENDING",
    nextNodeId: node.id,
    eventType: "CONTENT_LINKS_SUBMITTED",
    eventPayload: {
      urls: [],
      linkCount: 0,
      nudgeSent: true,
      ...(latestInbound ? { messageId: latestInbound.id } : {}),
    },
  };
}
