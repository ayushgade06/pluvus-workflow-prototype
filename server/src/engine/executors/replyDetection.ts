import type { Message, ReplyIntent } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { listMessagesByInstance as listMessagesDb } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { extractReplyText } from "./replyText.js";
import { looksLikeOptOut } from "../../adapters/classification/classifierSpec.js";

// Replies with confidence below this threshold are treated as UNKNOWN and
// routed to MANUAL_REVIEW rather than auto-advanced.
const LOW_CONFIDENCE_THRESHOLD = 0.50;

// DB seam — injectable so the routing logic (incl. the active-negotiation
// short-circuit and the A1/A2 low-confidence MANUAL_REVIEW hand-off) is
// unit-testable without a live database. Defaults to the real db helpers.
export interface ReplyDetectionDeps {
  listMessagesByInstance(instanceId: string): Promise<Message[]>;
  updateMessageClassification(
    id: string,
    intent: ReplyIntent,
    confidence: number,
  ): Promise<void>;
}

const defaultDeps: ReplyDetectionDeps = {
  listMessagesByInstance: listMessagesDb,
  updateMessageClassification: async (id, intent, confidence) => {
    await prisma.message.update({
      where: { id },
      data: { replyIntent: intent, classifyConfidence: confidence },
    });
  },
};

export async function executeReplyDetection(
  ctx: ExecutionContext,
  // Kept for dispatcher call-signature parity with the other executors; reply
  // detection no longer sends any email itself (the low-confidence hand-off is a
  // plain MANUAL_REVIEW; runtime sends the brand FYI).
  _email: IEmailProvider,
  agent: IAgentProvider,
  deps: ReplyDetectionDeps = defaultDeps,
): Promise<NodeResult> {
  const { instance, node, nodeGraph } = ctx;

  if (instance.currentState !== "REPLY_RECEIVED") {
    throw new Error(
      `REPLY_DETECTION expects REPLY_RECEIVED state, got ${instance.currentState}`,
    );
  }

  const messages = await deps.listMessagesByInstance(instance.id);
  const inboundMessages = messages.filter((m) => m.direction === "INBOUND");

  if (inboundMessages.length === 0) {
    throw new Error(`No inbound messages found for instance ${instance.id}`);
  }

  const latestInbound = inboundMessages[inboundMessages.length - 1];
  if (!latestInbound) {
    throw new Error(`No inbound messages found for instance ${instance.id}`);
  }

  // H1: classify/gate the creator's ACTUAL reply, not the raw body (see the
  // fuller note above the classify call below). Computed BEFORE the
  // active-negotiation short-circuit so the opt-out gate scans every inbound.
  const replyText = extractReplyText(latestInbound.body);

  // ── Deterministic opt-out gate — EVERY inbound, EVERY round (MED-W1) ──────
  // "unsubscribe" / "stop emailing me" must be honored regardless of where the
  // conversation is. Round 0 already gets this via the classifier's own opt-out
  // gate, but the round >= 1 short-circuit below skips classification entirely —
  // which meant a mid-negotiation opt-out got a counter-offer instead of an
  // opt-out (CAN-SPAM exposure). This is code, not a model call: no prompt
  // injection or model failure can suppress it.
  if (looksLikeOptOut(replyText)) {
    await deps.updateMessageClassification(latestInbound.id, "OPT_OUT", 1);
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

  // ── Active-negotiation short-circuit ──────────────────────────────────────
  // A reply that arrives AFTER we've already sent at least one counter
  // (negotiationRound >= 1) is a negotiation turn, NOT a fresh first reply. It
  // must go to the negotiation agent — which compares the creator's stated rate
  // against the band (e.g. $480 <= $500 ceiling -> ACCEPT) — not back through the
  // first-reply classifier whose only "no" bucket (NEGATIVE) terminates the
  // instance at REJECTED. Re-classifying mid-negotiation is what caused a plain
  // "I charge 480 dollars" to be rejected instead of accepted.
  //
  // negotiationRound is incremented only when the negotiation executor sends a
  // counter, so >= 1 precisely means "negotiation is already underway". The
  // first reply (round 0) still goes through normal classification below.
  if (instance.negotiationRound >= 1) {
    const negotiationNode =
      nodeGraph.find((n) => n.type === "NEGOTIATION") ??
      nodeGraph.find((n) => n.order === node.order + 1) ??
      null;
    return {
      nextState: "NEGOTIATING",
      nextNodeId: negotiationNode?.id ?? null,
      eventType: "REPLY_CLASSIFIED",
      eventPayload: {
        // Not a fresh classification — routed straight to the negotiation agent
        // because a negotiation is already in progress (round >= 1).
        intent: "NEGOTIATION_IN_PROGRESS",
        confidence: 1,
        routedToNegotiation: true,
        negotiationRound: instance.negotiationRound,
        messageId: latestInbound.id,
      },
    };
  }

  // H1: classify the creator's ACTUAL reply, not the raw body. The raw body
  // quotes our own outreach ("interested", "rate", "commission") plus the
  // creator's signature; classifying that lets the quoted history dominate the
  // signal (a "No." can read POSITIVE). extractReplyText strips quoted thread +
  // signature and falls back to the raw body if it would over-cut. The raw body
  // remains persisted on the Message row for audit. (replyText is computed
  // above, before the opt-out gate + short-circuit.)
  let { intent, confidence } = await agent.classify(replyText);

  // Enforce low-confidence threshold: if the classifier is not confident
  // enough, override to UNKNOWN so the reply routes to MANUAL_REVIEW.
  if (confidence < LOW_CONFIDENCE_THRESHOLD) {
    intent = "UNKNOWN";
  }

  // Persist intent (which may now be UNKNOWN) + raw confidence score.
  await deps.updateMessageClassification(latestInbound.id, intent, confidence);

  const negotiationNode = nodeGraph.find((n) => n.order === node.order + 1) ?? null;

  switch (intent) {
    case "POSITIVE":
    case "QUESTION":
      return {
        nextState: "NEGOTIATING",
        nextNodeId: negotiationNode?.id ?? null,
        eventType: "REPLY_CLASSIFIED",
        eventPayload: { intent, confidence, messageId: latestInbound.id },
      };

    case "NEGATIVE":
      return {
        nextState: "REJECTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "REPLY_CLASSIFIED",
        eventPayload: { intent, confidence, messageId: latestInbound.id },
      };

    case "OPT_OUT":
      return {
        nextState: "OPTED_OUT",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "REPLY_CLASSIFIED",
        eventPayload: { intent, confidence, messageId: latestInbound.id },
      };

    case "UNKNOWN":
    default:
      // A1/A2 (low_confidence_reply): the classifier couldn't confidently read
      // the creator's intent. V1 (#14): escalation is a clean one-way handoff —
      // route to MANUAL_REVIEW (terminal). runtime emails the brand an FYI (keyed
      // on this reason) and the conversation surfaces in the Manual Queue, where a
      // human reads the intent the AI couldn't and takes over out-of-band. No
      // brand-decision round-trip, no auto-resume.
      return {
        nextState: "MANUAL_REVIEW",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "MANUAL_REVIEW_FLAGGED",
        eventPayload: {
          intent,
          confidence,
          messageId: latestInbound.id,
          reason: "low_confidence_reply",
        },
      };
  }
}
