import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { sendOnce } from "./idempotentSend.js";

export async function executeInitialOutreach(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;

  if (instance.currentState !== "ENROLLED") {
    throw new Error(
      `INITIAL_OUTREACH expects ENROLLED state, got ${instance.currentState}`,
    );
  }

  const config = node.config;
  const bodyTemplate = typeof config["bodyTemplate"] === "string" ? config["bodyTemplate"] : "";

  // Try AI-generated draft first; fall back to template-based email.draft().
  const aiDraft = await agent.draftEmail("initial_outreach", creator, config);
  const draft = aiDraft ?? await email.draft(creator, bodyTemplate, config);

  // FIX-11: reserve-before-send so a crash between send and the row write can't
  // double-send the outreach on a BullMQ retry. One outreach per instance.
  const { messageId, threadId } = await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `outreach:${instance.id}`,
  );

  const nextNode = nodeGraph.find((n) => n.order === node.order + 1) ?? null;

  return {
    nextState: "OUTREACH_SENT",
    nextNodeId: nextNode?.id ?? null,
    eventType: "OUTREACH_DRAFTED",
    eventPayload: {
      subject: draft.subject,
      messageId,
      threadId,
      aiGenerated: aiDraft !== null,
    },
  };
}
