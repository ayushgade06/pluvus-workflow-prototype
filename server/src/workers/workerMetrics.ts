import type { Queue } from "bullmq";
import type { InstanceState } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getNodeExecutionQueue, getInboundEmailQueue } from "./queues.js";
import { TERMINAL_STATES } from "../observability/dto.js";

// ---------------------------------------------------------------------------
// HARD-S1: worker-fleet metrics (queue depth + stuck-state counts)
// ---------------------------------------------------------------------------
// Scalability was un-observable: no way to see how backed-up the queues are or
// how many instances are stranded, so a fleet couldn't be sized or alerted on.
// This module is the CODE-SIDE scaffolding for that — two cheap reads a metrics
// backend / autoscaler / health probe can poll:
//
//   * queue depth — waiting/active/delayed/failed per BullMQ queue. Rising
//     `waiting` with pinned `active` = the fleet is saturated (scale out the
//     PROCESS_ROLE=worker replicas from HARD-A1).
//   * stuck-state counts — non-terminal instances whose last update is older
//     than a threshold. A growing count = jobs are being lost/stranded (the
//     HARD-R1 sweep should be re-enqueuing them; a persistent count is an alert).
//
// The ACCEPTANCE CRITERION (NOT in this diff): a running monitoring backend
// scraping these + a load test to 1,000 concurrent proving the fleet holds. This
// code makes the numbers readable; the score moves once that infra + evidence
// exist. `collectWorkerMetrics` is the single call a scheduler tick / /metrics
// route / exporter invokes.

// A non-terminal instance whose `updatedAt` is older than this is "stuck" for
// metrics purposes (distinct from the scheduler's dueAt-based sweep — this is a
// coarse backstop count across ALL non-terminal states, not just waiting ones).
const STUCK_AGE_MS = Number(process.env["STUCK_STATE_AGE_MS"]) > 0
  ? Number(process.env["STUCK_STATE_AGE_MS"])
  : 30 * 60 * 1000; // 30 minutes

export interface QueueDepth {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface WorkerMetrics {
  queues: QueueDepth[];
  /** Non-terminal instances older than STUCK_AGE_MS, by state. */
  stuckByState: Record<string, number>;
  /** Total stuck instances across all non-terminal states. */
  stuckTotal: number;
}

/** BullMQ job counts for one queue, flattened to the four we alert on. */
async function queueDepth(queue: Queue): Promise<QueueDepth> {
  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
  return {
    queue: queue.name,
    waiting: counts["waiting"] ?? 0,
    active: counts["active"] ?? 0,
    delayed: counts["delayed"] ?? 0,
    failed: counts["failed"] ?? 0,
  };
}

/** Count non-terminal instances not touched within STUCK_AGE_MS, grouped by state. */
export async function stuckStateCounts(now: number = Date.now()): Promise<{
  byState: Record<string, number>;
  total: number;
}> {
  const cutoff = new Date(now - STUCK_AGE_MS);
  const rows = await prisma.executionInstance.groupBy({
    by: ["currentState"],
    where: {
      currentState: { notIn: TERMINAL_STATES as InstanceState[] },
      updatedAt: { lt: cutoff },
    },
    _count: { _all: true },
  });
  const byState: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const c = r._count._all;
    byState[r.currentState] = c;
    total += c;
  }
  return { byState, total };
}

/**
 * Collect the full worker-fleet metrics snapshot. Cheap (a few Redis + one
 * grouped SQL read); safe to call on a scheduler tick or a /metrics request.
 */
export async function collectWorkerMetrics(now: number = Date.now()): Promise<WorkerMetrics> {
  const [nodeQ, inboundQ, stuck] = await Promise.all([
    // The typed queues carry a specific job-data generic; queueDepth only reads
    // counts (data-agnostic), so widen to the base Queue type.
    queueDepth(getNodeExecutionQueue() as unknown as Queue),
    queueDepth(getInboundEmailQueue() as unknown as Queue),
    stuckStateCounts(now),
  ]);
  return {
    queues: [nodeQ, inboundQ],
    stuckByState: stuck.byState,
    stuckTotal: stuck.total,
  };
}

/**
 * Emit the metrics as a structured log line — the minimal "export" a log-based
 * metrics pipeline can scrape without a dedicated backend. Wire an OTel/Prometheus
 * exporter here (or in collectWorkerMetrics's caller) to ship to a real backend.
 * Never throws — a metrics read must not disturb the worker/scheduler loop.
 */
export async function logWorkerMetrics(now: number = Date.now()): Promise<void> {
  try {
    const m = await collectWorkerMetrics(now);
    for (const q of m.queues) {
      console.log(
        `[metrics] queue=${q.queue} waiting=${q.waiting} active=${q.active} ` +
          `delayed=${q.delayed} failed=${q.failed}`,
      );
    }
    console.log(
      `[metrics] stuck_total=${m.stuckTotal} stuck_by_state=${JSON.stringify(m.stuckByState)}`,
    );
  } catch (err) {
    console.error(
      `[metrics] failed to collect worker metrics: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
