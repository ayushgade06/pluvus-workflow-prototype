import { listDueInstances } from "../db/instances.js";
import { enqueueNodeExecution } from "../workers/queues.js";
import { logTrace } from "../observability/logger.js";
import { reconcileStuckInstances } from "./reconciliation.js";
import { logWorkerMetrics } from "../workers/workerMetrics.js";
import { acquireOrRenewLeadership } from "./lock.js";

// ---------------------------------------------------------------------------
// Due-instance poller
// ---------------------------------------------------------------------------
// Called every POLL_INTERVAL_MS. Enqueues a node-execution job for each
// due-instance follow-up: instances whose dueAt has passed and whose state is
// AWAITING_REPLY or FOLLOWED_UP. Uses deterministic jobIds so duplicate polls
// never double-enqueue the same trigger.

const POLL_INTERVAL_MS = 30_000;

let _timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  // W-8: leader election. `PROCESS_ROLE=scheduler` is meant to run as a single
  // leader, but nothing structurally stops two from being launched. If a second
  // one polls, its reconcile + due-scan re-run the same executors — and an
  // executor's agent (LLM) call runs BEFORE the OCC check, so a double-fire burns
  // real LLM spend even though sendOnce/OCC still block any duplicate email or
  // transition. Acquire (or renew) the Redis leader lease each cycle; only the
  // holder proceeds. A non-leader (or a Redis error) skips the whole cycle.
  const leader = await acquireOrRenewLeadership();
  if (!leader) return;

  // HARD-R1: reconciliation sweep — re-enqueue instances stranded in a transient
  // non-terminal state (crash between OCC commit and enqueue). Same cadence; its
  // own internal try/catch so a failure never affects the due-instance path.
  await reconcileStuckInstances();

  // HARD-S1: emit worker-fleet metrics (queue depth + stuck-state counts) on the
  // same cadence. logWorkerMetrics swallows its own errors, so a metrics read can
  // never disturb the due-instance path. This is the scaffolding a monitoring
  // backend scrapes; the load-test-to-1000 acceptance criterion is the infra
  // behind it, not this call.
  await logWorkerMetrics();

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
