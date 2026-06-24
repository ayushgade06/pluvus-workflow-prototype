import { createMessage } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

export async function executeFollowUp(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, creator } = ctx;
  const config = node.config;
  const maxCount = typeof config["maxCount"] === "number" ? config["maxCount"] : 3;

  // Case 1: Just sent outreach, entering the waiting period
  if (instance.currentState === "OUTREACH_SENT") {
    return {
      nextState: "AWAITING_REPLY",
      nextNodeId: node.id, // stay at follow-up node, waiting
      eventType: "NODE_ENTERED",
      eventPayload: { followUpCount: 0, nodeId: node.id },
    };
  }

  // Case 2: Rescheduled after a previous follow-up was sent (FOLLOWED_UP → AWAITING_REPLY)
  if (instance.currentState === "FOLLOWED_UP") {
    return {
      nextState: "AWAITING_REPLY",
      nextNodeId: node.id,
      eventType: "NODE_ENTERED",
      eventPayload: { followUpCount: instance.followUpCount, nodeId: node.id },
    };
  }

  // Case 3: AWAITING_REPLY — a follow-up is due
  if (instance.currentState === "AWAITING_REPLY") {
    if (instance.followUpCount >= maxCount) {
      // Max follow-ups reached — no response
      return {
        nextState: "NO_RESPONSE",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NODE_COMPLETED",
        eventPayload: { reason: "max_follow_ups_reached", followUpCount: instance.followUpCount },
      };
    }

    // Send follow-up email
    const bodyTemplate =
      typeof config["bodyTemplate"] === "string" ? config["bodyTemplate"] : "";
    const draft = await email.draft(creator, bodyTemplate, config);
    const { messageId, threadId } = await email.send(draft, creator);

    await createMessage({
      instance: { connect: { id: instance.id } },
      direction: "OUTBOUND",
      subject: draft.subject,
      body: draft.body,
      threadId,
      externalMessageId: messageId,
      sentAt: new Date(),
    });

    const newFollowUpCount = instance.followUpCount + 1;

    return {
      nextState: "FOLLOWED_UP",
      nextNodeId: node.id, // come back here to reschedule
      followUpCount: newFollowUpCount,
      eventType: "FOLLOW_UP_DUE",
      eventPayload: { followUpCount: newFollowUpCount, messageId, threadId },
    };
  }

  throw new Error(
    `FOLLOW_UP executor called in unexpected state: ${instance.currentState}`,
  );
}
