import type { ExecutionInstance } from "../db/schema.js";
import { listStuckInstances } from "../db/instances.js";
import { enqueueNodeExecution } from "../workers/queues.js";
import type { NodeExecutionJobData } from "../workers/jobs.js";
import { logTrace } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Reconciliation sweep (HARD-R1)
// ---------------------------------------------------------------------------
// Runs on the scheduler poll cadence. Recovers instances stranded in a TRANSIENT
// non-terminal state (see RECONCILE_STATES in db/instances.ts) — the ones a crash
// or Redis blip BETWEEN a state commit (OCC update) and the follow-on job enqueue
// can leave with no queued work. The old poller covered only AWAITING_REPLY /
// FOLLOWED_UP, so 10 of 12 non-terminal states had no recovery: e.g. an instance
// that committed ACCEPTED but crashed before enqueuing the Content Brief step, or
// one stranded at REPLY_RECEIVED (CRITICAL-6 path), sat invisibly forever.
//
// How it recovers: re-enqueue a node-execution job for the instance keyed on its
// CURRENT state. The node-execution worker re-reads state on entry and OCC guards
// every write, so re-enqueuing an instance that is actually fine (just briefly
// mid-step) is a harmless no-op — never a double-step or double-send. This is why
// the sweep can be aggressive without risk: OCC + sendOnce are the real
// guarantees; the sweep only ensures a job EXISTS.
//
// STALENESS: only sweep instances whose updatedAt is older than STALE_AFTER_MS,
// so an instance that is legitimately mid-step this very tick is not fought.
//
// Note: this is the operational backstop. The durable fix is the transactional
// outbox (OutboxJob model — schema scaffold landed with this item); once its relay
// is wired, state-commit + enqueue become atomic and this sweep becomes a
// belt-and-braces safety net rather than the primary recovery.

// An instance mid-step normally advances within a step's worth of time. Anything
// sitting in a transient state longer than this was almost certainly stranded.
// Generous enough to clear a slow negotiation step (see lock TTL) before acting.
const STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes

// Time bucket for the deterministic triggerRef, so overlapping/rapid sweeps of the
// same still-stuck instance collapse to ONE BullMQ job per bucket instead of
// piling up. A stuck instance is retried once per bucket until it clears.
const RECONCILE_BUCKET_MS = STALE_AFTER_MS;

// Injectable seam so the sweep's batching + dedupe-triggerRef logic is unit-
// testable without a live DB or Redis. Defaults to the real helpers.
export interface ReconciliationDeps {
  listStuckInstances(staleBefore: Date): Promise<ExecutionInstance[]>;
  enqueueNodeExecution(data: NodeExecutionJobData): Promise<void>;
}

const defaultDeps: ReconciliationDeps = {
  listStuckInstances,
  enqueueNodeExecution,
};

export async function reconcileStuckInstances(
  now: Date = new Date(),
  deps: ReconciliationDeps = defaultDeps,
): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);

  let stuck;
  try {
    stuck = await deps.listStuckInstances(staleBefore);
  } catch (err) {
    console.error(
      "[scheduler/reconciliation] DB query failed:",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  if (stuck.length === 0) return 0;

  console.log(`[scheduler/reconciliation] ${stuck.length} stuck instance(s) found`);

  const bucket = Math.floor(now.getTime() / RECONCILE_BUCKET_MS);

  let reEnqueued = 0;
  const results = await Promise.allSettled(
    stuck.map(async (inst) => {
      // Deterministic triggerRef → BullMQ dedupes duplicate enqueues across
      // overlapping polls (colon-free, per HARD-R1 note in the poller).
      const triggerRef = `reconcile-${inst.id}-${inst.currentState}-${bucket}`;
      await deps.enqueueNodeExecution({
        instanceId: inst.id,
        expectedState: inst.currentState,
        triggerRef,
      });
      reEnqueued++;
      console.log(
        `[scheduler/reconciliation] re-enqueued stuck ${inst.id} (${inst.currentState}, last updated ${inst.updatedAt.toISOString()})`,
      );
      logTrace("reconciliation_reenqueued", {
        source: "scheduler",
        instanceId: inst.id,
        creatorId: inst.creatorId,
        state: inst.currentState,
        updatedAt: inst.updatedAt.toISOString(),
        triggerRef,
      });
    }),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      console.error(
        "[scheduler/reconciliation] re-enqueue failed:",
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
  }

  return reEnqueued;
}
