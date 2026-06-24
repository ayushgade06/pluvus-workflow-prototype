import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { QUEUE_NODE_EXECUTION } from "./queues.js";
import type { NodeExecutionJobData } from "./jobs.js";
import { WorkflowRuntime, StaleInstanceError } from "../engine/runtime.js";
import { MockEmailProvider, MockAgentProvider } from "../engine/providers.js";
import { findInstanceById } from "../db/index.js";
import { isTerminal } from "../engine/stateMachine.js";
import { acquireLock, releaseLock } from "../scheduler/lock.js";

// ---------------------------------------------------------------------------
// NodeExecution worker
// ---------------------------------------------------------------------------
// Advances one ExecutionInstance by one step through its current node.
//
// Idempotency guarantee:
//   The job carries `expectedState`. On entry the worker re-reads the live
//   instance state. If it no longer matches `expectedState`, the instance has
//   already been advanced (previous delivery or concurrent inbound-email job)
//   and the worker exits without touching state.
//
// Instance-level serialization:
//   A deterministic jobId (instanceId + expectedState + triggerRef) ensures at
//   most one job per logical trigger is ever in the queue. Combined with the
//   idempotency check above, two workers can never double-advance an instance.

// ---------------------------------------------------------------------------
// Runtime (shared across all jobs in this worker process)
// ---------------------------------------------------------------------------
// Phase 4 uses mock providers. Phases 6–8 swap these for real adapters.

const runtime = new WorkflowRuntime(
  new MockEmailProvider(),
  new MockAgentProvider(),
);

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------

async function handleNodeExecution(
  job: Job<NodeExecutionJobData>,
): Promise<void> {
  const { instanceId, expectedState, triggerRef } = job.data;

  // ── Idempotency check ───────────────────────────────────────────────────
  const instance = await findInstanceById(instanceId);
  if (!instance) {
    console.warn(`[node-execution] instance not found: ${instanceId} (job ${job.id})`);
    return;
  }

  if (instance.currentState !== expectedState) {
    console.log(
      `[node-execution] skip — instance ${instanceId} is ${instance.currentState}, expected ${expectedState} (job ${job.id}, ref ${triggerRef})`,
    );
    return;
  }

  if (isTerminal(instance.currentState)) {
    console.log(
      `[node-execution] skip — instance ${instanceId} is terminal (${instance.currentState}) (job ${job.id})`,
    );
    return;
  }

  // ── Acquire instance lock ────────────────────────────────────────────────
  const locked = await acquireLock(instanceId);
  if (!locked) {
    console.log(`[node-execution] lock busy — skip ${instanceId} (job ${job.id})`);
    return;
  }

  // ── Execute ─────────────────────────────────────────────────────────────
  console.log(
    `[node-execution] advancing ${instanceId} from ${expectedState} (job ${job.id})`,
  );

  try {
    await runtime.stepInstance(instanceId);
  } catch (err) {
    if (err instanceof StaleInstanceError) {
      console.log(`[node-execution] OCC conflict — ${err.message} (job ${job.id})`);
      return; // another worker already advanced this instance — clean skip
    }
    throw err;
  } finally {
    await releaseLock(instanceId);
  }

  const updated = await findInstanceById(instanceId);
  console.log(
    `[node-execution] done — ${instanceId}: ${expectedState} → ${updated?.currentState ?? "unknown"} (job ${job.id})`,
  );
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

const WORKER_CONCURRENCY = 5;

export function createNodeExecutionWorker(): Worker<NodeExecutionJobData> {
  const worker = new Worker<NodeExecutionJobData>(
    QUEUE_NODE_EXECUTION,
    handleNodeExecution,
    {
      connection: redisConnection(),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[node-execution] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}/${job?.opts?.attempts ?? "?"}):`,
      err.message,
    );
  });

  worker.on("error", (err) => {
    console.error("[node-execution] worker error:", err.message);
  });

  return worker;
}
