import { createMessage } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

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
