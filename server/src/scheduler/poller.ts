import { listDueInstances } from "../db/instances.js";
import { enqueueNodeExecution } from "../workers/queues.js";
import { logTrace } from "../observability/logger.js";
import { sweepExpiredBrandDecisions } from "./brandDecisionSweep.js";
import { reconcileStuckInstances } from "./reconciliation.js";

// ---------------------------------------------------------------------------
// Due-instance poller
// ---------------------------------------------------------------------------
// Called every POLL_INTERVAL_MS. Two independent responsibilities on the same
// cadence:
//   1. Due-instance follow-ups: instances whose dueAt has passed and whose state
//      is AWAITING_REPLY or FOLLOWED_UP → enqueue a node-execution job for each.
//   2. Brand-decision silence timeout: PENDING BrandDecisions past their
//      expiresAt (72h) → MANUAL_REVIEW + operator ping (§2.6). Runs regardless of
//      whether any instance is due, and its failures never affect (1).
// Uses deterministic jobIds so duplicate polls never double-enqueue the same
// trigger; the brand-decision sweep is idempotent via OCC.

const POLL_INTERVAL_MS = 30_000;

let _timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  // Run the brand-decision timeout sweep on the same cadence. Isolated in its
  // own try/catch inside the sweep so it can neither throw into nor be starved
  // by the due-instance path below.
  await sweepExpiredBrandDecisions();

  // HARD-R1: reconciliation sweep — re-enqueue instances stranded in a transient
  // non-terminal state (crash between OCC commit and enqueue). Same cadence; its
  // own internal try/catch so a failure never affects the due-instance path.
  await reconcileStuckInstances();

  let instances;
  try {
    instances = await listDueInstances();
  } catch (err) {
    console.error("[scheduler/poller] DB query failed:", err instanceof Error ? err.message : err);
    return;
  }

  if (instances.length === 0) return;

  console.log(`[scheduler/poller] ${instances.length} due instance(s) found`);

  await Promise.allSettled(
    instances.map(async (inst) => {
      try {
        // Deterministic triggerRef: prevents double-enqueue across overlapping polls.
        // Replace : with - so BullMQ jobId generation stays colon-free.
        // "sched" prefix distinguishes scheduler-triggered from worker-triggered jobs.
        const dueStr = (inst.dueAt?.toISOString() ?? "none").replace(/:/g, "-");
        const triggerRef = `sched-${inst.id}-${inst.currentState}-${dueStr}`;
        await enqueueNodeExecution({
          instanceId: inst.id,
          expectedState: inst.currentState,
          triggerRef,
        });
        console.log(`[scheduler/poller] enqueued ${inst.id} (${inst.currentState})`);
        logTrace("scheduler_enqueued", {
          source: "scheduler",
          instanceId: inst.id,
          creatorId: inst.creatorId,
          state: inst.currentState,
          dueAt: inst.dueAt?.toISOString() ?? null,
          triggerRef,
        });
      } catch (err) {
        console.error(
          `[scheduler/poller] failed to enqueue ${inst.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}

export function startPoller(intervalMs: number = POLL_INTERVAL_MS): void {
  if (_timer) return; // idempotent
  // Run immediately on start so tests don't have to wait for the first interval.
  poll().catch((err) =>
    console.error("[scheduler/poller] initial poll error:", err instanceof Error ? err.message : err),
  );
  _timer = setInterval(() => {
    poll().catch((err) =>
      console.error("[scheduler/poller] poll error:", err instanceof Error ? err.message : err),
    );
  }, intervalMs);
  console.log(`[scheduler/poller] started (interval: ${intervalMs}ms)`);
}

export function stopPoller(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log("[scheduler/poller] stopped");
  }
}
