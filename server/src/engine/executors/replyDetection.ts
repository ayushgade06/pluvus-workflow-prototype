import type { Message, ReplyIntent } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { listMessagesByInstance as listMessagesDb } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

// Replies with confidence below this threshold are treated as UNKNOWN and
// routed to MANUAL_REVIEW rather than auto-advanced.
const LOW_CONFIDENCE_THRESHOLD = 0.70;

// DB seam — injectable so the routing logic (incl. the active-negotiation
// short-circuit) is unit-testable without a live database. Defaults to real db.
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

  let { intent, confidence } = await agent.classify(latestInbound.body);

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
      return {
        nextState: "MANUAL_REVIEW",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "MANUAL_REVIEW_FLAGGED",
        eventPayload: { intent, confidence, messageId: latestInbound.id },
      };
  }
}
