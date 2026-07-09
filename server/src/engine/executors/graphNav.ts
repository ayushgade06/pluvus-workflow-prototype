import type { ExecutionContext } from "../types.js";

// ---------------------------------------------------------------------------
// Shared linear-graph navigation (HARD-A2)
// ---------------------------------------------------------------------------
// Resolve the node that FOLLOWS the current node in the (linear) graph, or null
// when the current node is last (which the engine treats as terminal). This was
// duplicated byte-for-byte in paymentInfo.ts and rewardReply.ts — a maintenance
// hazard if the linear-order convention ever changes. One definition now.
export function nextNodeAfter(ctx: ExecutionContext): string | null {
  const { node, nodeGraph } = ctx;
  const next = nodeGraph.find((n) => n.order === node.order + 1);
  return next?.id ?? null;
}
