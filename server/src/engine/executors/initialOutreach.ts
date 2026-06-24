import { createMessage } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

export async function executeInitialOutreach(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;

  if (instance.currentState !== "ENROLLED") {
    throw new Error(
      `INITIAL_OUTREACH expects ENROLLED state, got ${instance.currentState}`,
    );
  }

  const config = node.config;
  const bodyTemplate = typeof config["bodyTemplate"] === "string" ? config["bodyTemplate"] : "";

  // Draft and send the email via mock provider
  const draft = await email.draft(creator, bodyTemplate, config);
  const { messageId, threadId } = await email.send(draft, creator);

  // Persist outbound message record
  await createMessage({
    instance: { connect: { id: instance.id } },
    direction: "OUTBOUND",
    subject: draft.subject,
    body: draft.body,
    threadId,
    externalMessageId: messageId,
    sentAt: new Date(),
  });

  // Find the follow-up node (next by order)
  const nextNode = nodeGraph.find((n) => n.order === node.order + 1) ?? null;

  return {
    nextState: "OUTREACH_SENT",
    nextNodeId: nextNode?.id ?? null,
    eventType: "OUTREACH_DRAFTED",
    eventPayload: { subject: draft.subject, messageId, threadId },
  };
}
