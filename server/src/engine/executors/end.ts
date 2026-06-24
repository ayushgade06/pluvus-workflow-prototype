import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

export async function executeEnd(
  ctx: ExecutionContext,
  _email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance } = ctx;

  return {
    nextState: instance.currentState, // already terminal — no change
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NODE_COMPLETED",
    eventPayload: { finalState: instance.currentState },
  };
}
