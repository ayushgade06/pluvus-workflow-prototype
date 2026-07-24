// ---------------------------------------------------------------------------
// metrics — honest DERIVED observability signals from the live snapshot.
// ---------------------------------------------------------------------------
// The API exposes a point-in-time snapshot only (no time-series history), so we
// do NOT invent throughput / success-rate / sparklines. Everything here is a
// deterministic function of the current WorkflowNodeSummary[] — a lens on real
// numbers, never a fabricated trend.
import type { WorkflowNodeSummary, InstanceState, InstanceListItem } from "../../api/types";

// The operational status a node card + badge should show. Derived from the
// snapshot: terminal flag, stuck count, whether it's a review/blocked lane, and
// whether anyone is currently in it.
export type NodeStatus = "live" | "review" | "blocked" | "terminal" | "idle";

const REVIEW_STATES = new Set<InstanceState>(["MANUAL_REVIEW", "NEEDS_DEAL_FINALIZATION"]);

export function nodeStatus(n: WorkflowNodeSummary): NodeStatus {
  if (REVIEW_STATES.has(n.state)) return n.count > 0 ? "review" : "idle";
  if (n.stuck > 0) return "blocked";
  if (n.terminal) return "terminal";
  if (n.count > 0) return "live";
  return "idle";
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  live: "Live",
  review: "Review",
  blocked: "Blocked",
  terminal: "Terminal",
  idle: "Idle",
};

// A stage's "load" as a fraction of the busiest active stage — drives the small
// progress bar on the node. Real ratio of real counts, nothing invented.
export function loadFraction(n: WorkflowNodeSummary, maxActiveCount: number): number {
  if (maxActiveCount <= 0 || n.terminal) return 0;
  return Math.min(1, n.count / maxActiveCount);
}

export interface PipelineHealth {
  /** 0–100. 100 = nothing stuck, no long waits. Derived, labelled as such. */
  score: number;
  band: "healthy" | "watch" | "degraded";
  totalStuck: number;
  /** The state that most looks like a bottleneck, or null if none stand out. */
  bottleneck: InstanceState | null;
  activeInPipeline: number;
}

// Health = start at 100, subtract for stuck creators (weighted) and for a high
// share of creators piled in any single active stage. Deterministic + explained.
export function pipelineHealth(nodes: WorkflowNodeSummary[]): PipelineHealth {
  const active = nodes.filter((n) => !n.terminal);
  const activeInPipeline = active.reduce((a, n) => a + n.count, 0);
  const totalStuck = nodes.reduce((a, n) => a + n.stuck, 0);
  const totalActive = Math.max(1, activeInPipeline);

  // Stuck penalty: each stuck creator hurts, saturating so a few don't zero it.
  const stuckRatio = totalStuck / totalActive;
  const stuckPenalty = Math.min(55, Math.round(stuckRatio * 140));

  // Bottleneck = the active, non-entry stage holding the largest share of the
  // in-pipeline population (ties broken by stuck count, then avg wait).
  let bottleneck: InstanceState | null = null;
  let worst = -1;
  for (const n of active) {
    if (n.count === 0) continue;
    const share = n.count / totalActive;
    const score = share * 100 + n.stuck * 8 + (n.avgTimeInStateSeconds ?? 0) / 3600;
    if (score > worst) {
      worst = score;
      bottleneck = n.state;
    }
  }
  // Only call it a bottleneck if it's genuinely concentrated.
  const bnNode = bottleneck ? nodes.find((n) => n.state === bottleneck) : null;
  const concentrated = bnNode ? bnNode.count / totalActive >= 0.4 && activeInPipeline >= 3 : false;

  const concentrationPenalty = concentrated ? 15 : 0;
  const score = Math.max(0, Math.min(100, 100 - stuckPenalty - concentrationPenalty));
  const band: PipelineHealth["band"] = score >= 80 ? "healthy" : score >= 50 ? "watch" : "degraded";

  return {
    score,
    band,
    totalStuck,
    bottleneck: concentrated ? bottleneck : null,
    activeInPipeline,
  };
}

// Longest-waiting creator in a stage's fetched instance list (real max). Used
// by the inspector's "oldest creator" line.
export function oldestWaiter(items: InstanceListItem[]): InstanceListItem | null {
  let out: InstanceListItem | null = null;
  for (const it of items) {
    if (!out || it.waitingForSeconds > out.waitingForSeconds) out = it;
  }
  return out;
}
