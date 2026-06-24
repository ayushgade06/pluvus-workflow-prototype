import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider } from "../providers.js";
import type { IAgentProvider } from "../providers.js";

export async function executeImportCreatorList(
  ctx: ExecutionContext,
  _email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph } = ctx;

  if (instance.currentState !== "ENROLLED") {
    throw new Error(
      `IMPORT_CREATOR_LIST expects ENROLLED state, got ${instance.currentState}`,
    );
  }

  // Advance to the next node (outreach) by order
  const nextNode = nodeGraph.find((n) => n.order === node.order + 1) ?? null;

  return {
    nextState: "ENROLLED",
    nextNodeId: nextNode?.id ?? null,
    eventType: "NODE_COMPLETED",
    eventPayload: { nodeId: node.id, creatorId: instance.creatorId },
  };
}
