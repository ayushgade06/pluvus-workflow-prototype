import type { ReplyIntent } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { listMessagesByInstance } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

// Inline helper — updates classification fields on a Message row.
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

  // Find the most recent inbound message for this instance
  const messages = await listMessagesByInstance(instance.id);
  const inboundMessages = messages.filter((m) => m.direction === "INBOUND");

  if (inboundMessages.length === 0) {
    throw new Error(`No inbound messages found for instance ${instance.id}`);
  }

  // The last inbound message is the one to classify
  const latestInbound = inboundMessages[inboundMessages.length - 1];
  if (!latestInbound) {
    throw new Error(`No inbound messages found for instance ${instance.id}`);
  }

  const { intent, confidence } = await agent.classify(latestInbound.body);

  // Persist classification on the message
  await updateMessageClassification(latestInbound.id, intent, confidence);

  // Find negotiation node (next by order)
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
  }
}
