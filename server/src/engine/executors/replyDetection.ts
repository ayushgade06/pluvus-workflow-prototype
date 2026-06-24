import type { ReplyIntent } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { listMessagesByInstance } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

// Replies with confidence below this threshold are treated as UNKNOWN and
// routed to MANUAL_REVIEW rather than auto-advanced.
const LOW_CONFIDENCE_THRESHOLD = 0.70;

async function updateMessageClassification(
  id: string,
  intent: ReplyIntent,
  confidence: number,
): Promise<void> {
  await prisma.message.update({
    where: { id },
    data: { replyIntent: intent, classifyConfidence: confidence },
  });
}

export async function executeReplyDetection(
  ctx: ExecutionContext,
  _email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph } = ctx;

  if (instance.currentState !== "REPLY_RECEIVED") {
    throw new Error(
      `REPLY_DETECTION expects REPLY_RECEIVED state, got ${instance.currentState}`,
    );
  }

  const messages = await listMessagesByInstance(instance.id);
  const inboundMessages = messages.filter((m) => m.direction === "INBOUND");

  if (inboundMessages.length === 0) {
    throw new Error(`No inbound messages found for instance ${instance.id}`);
  }

  const latestInbound = inboundMessages[inboundMessages.length - 1];
  if (!latestInbound) {
    throw new Error(`No inbound messages found for instance ${instance.id}`);
  }

  let { intent, confidence } = await agent.classify(latestInbound.body);

  // Enforce low-confidence threshold: if the classifier is not confident
  // enough, override to UNKNOWN so the reply routes to MANUAL_REVIEW.
  if (confidence < LOW_CONFIDENCE_THRESHOLD) {
    intent = "UNKNOWN";
  }

  // Persist intent (which may now be UNKNOWN) + raw confidence score.
  await updateMessageClassification(latestInbound.id, intent, confidence);

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
