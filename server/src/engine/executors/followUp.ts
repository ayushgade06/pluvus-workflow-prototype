import { createMessage } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

function resolveIntervalMs(config: Record<string, unknown>, followUpIndex: number): number {
  const intervals = Array.isArray(config["intervals"]) ? config["intervals"] as number[] : [3, 5, 7];
  const unit = typeof config["intervalUnit"] === "string" ? config["intervalUnit"] : "days";
  const value = intervals[followUpIndex] ?? intervals[intervals.length - 1] ?? 3;
  const multiplier = unit === "seconds" ? 1000 : 24 * 60 * 60 * 1000;
  return value * multiplier;
}

export async function executeFollowUp(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, creator } = ctx;
  const config = node.config;
  const maxCount = typeof config["maxCount"] === "number" ? config["maxCount"] : 3;

  // Case 1: Just sent outreach — enter the first waiting period.
  if (instance.currentState === "OUTREACH_SENT") {
    const dueAt = new Date(Date.now() + resolveIntervalMs(config, 0));
    return {
      nextState: "AWAITING_REPLY",
      nextNodeId: node.id,
      dueAt,
      eventType: "NODE_ENTERED",
      eventPayload: { followUpCount: 0, nodeId: node.id, dueAt: dueAt.toISOString() },
    };
  }

  // Case 2: Rescheduled after sending a follow-up.
  if (instance.currentState === "FOLLOWED_UP") {
    const dueAt = new Date(Date.now() + resolveIntervalMs(config, instance.followUpCount));
    return {
      nextState: "AWAITING_REPLY",
      nextNodeId: node.id,
      dueAt,
      eventType: "NODE_ENTERED",
      eventPayload: { followUpCount: instance.followUpCount, nodeId: node.id, dueAt: dueAt.toISOString() },
    };
  }

  // Case 3: AWAITING_REPLY — a follow-up is due (triggered by scheduler).
  if (instance.currentState === "AWAITING_REPLY") {
    if (instance.followUpCount >= maxCount) {
      return {
        nextState: "NO_RESPONSE",
        nextNodeId: null,
        completedAt: new Date(),
        dueAt: null,
        eventType: "NODE_COMPLETED",
        eventPayload: { reason: "max_follow_ups_reached", followUpCount: instance.followUpCount },
      };
    }

    const bodyTemplate =
      typeof config["bodyTemplate"] === "string" ? config["bodyTemplate"] : "";

    // Try AI-generated follow-up copy; fall back to template-based email.draft().
    const followUpRound = instance.followUpCount + 1;
    const aiDraft = await agent.draftEmail("follow_up", creator, config, { round: followUpRound });
    const draft = aiDraft ?? await email.draft(creator, bodyTemplate, config);
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
      nextNodeId: node.id,
      followUpCount: newFollowUpCount,
      dueAt: null,
      eventType: "FOLLOW_UP_DUE",
      eventPayload: {
        followUpCount: newFollowUpCount,
        messageId,
        threadId,
        aiGenerated: aiDraft !== null,
      },
    };
  }

  throw new Error(
    `FOLLOW_UP executor called in unexpected state: ${instance.currentState}`,
  );
}
