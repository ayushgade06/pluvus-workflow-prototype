import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";
import type { NodeExecutionJobData, InboundEmailJobData } from "./jobs.js";

// ---------------------------------------------------------------------------
// Queue names — single source of truth
// ---------------------------------------------------------------------------

export const QUEUE_NODE_EXECUTION = "node-execution";
export const QUEUE_INBOUND_EMAIL = "inbound-email";

// ---------------------------------------------------------------------------
// Worker concurrency (HARD-S1)
// ---------------------------------------------------------------------------
// Concurrency was hardcoded to 5/worker/process, so the whole system's LLM
// throughput was pinned regardless of how many replicas ran or how much agent-
// service capacity existed. HARD-A1 (Batch 1) split the process topology so a
// worker fleet can scale horizontally (PROCESS_ROLE=worker); this makes the
// PER-WORKER concurrency tunable too, so a fleet can be sized to the agent
// service's real capacity (each in-flight step holds a slot for a 45-120s LLM
// call, so the right number is capacity-matched, not a constant).
//
//   WORKER_CONCURRENCY               — default for both workers (default 5)
//   NODE_EXECUTION_CONCURRENCY       — override for the node-execution worker
//   INBOUND_EMAIL_CONCURRENCY        — override for the inbound-email worker
//
// Load-test note (the acceptance criterion, NOT satisfied by this diff): reaching
// 1,000 concurrent requires a multi-replica worker deployment + a capacity-matched
// agent service, then a load test proving it. This code makes the knob exist;
// the score only moves once that deployment + load evidence exist.
const DEFAULT_WORKER_CONCURRENCY = 5;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function workerConcurrency(specificEnv?: string): number {
  const base = positiveEnvInt("WORKER_CONCURRENCY", DEFAULT_WORKER_CONCURRENCY);
  return specificEnv ? positiveEnvInt(specificEnv, base) : base;
}

// ---------------------------------------------------------------------------
// Default retry / backoff configuration
// ---------------------------------------------------------------------------
// 3 attempts: immediate → 5 s → 25 s (exponential, base 5 s)

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 5_000,
  },
  // Remove completed jobs after 24 h to keep Redis lean
  removeOnComplete: { age: 86_400 },
  // Keep last 100 failed jobs for diagnostics
  removeOnFail: { count: 100 },
};

// ---------------------------------------------------------------------------
// Queue singletons — lazy-initialized, one per process
// ---------------------------------------------------------------------------
// Using `any` for the generic workaround: BullMQ v5 with exactOptionalPropertyTypes
// produces a spurious error when the Queue data type is inferred through the
// new ExtractDataType conditional. Casting to `Queue<T>` after construction
// is safe because add() is called with explicit typed data.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _nodeExecutionQueue: Queue<any> | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _inboundEmailQueue: Queue<any> | undefined;

export function getNodeExecutionQueue(): Queue<NodeExecutionJobData> {
  if (!_nodeExecutionQueue) {
    _nodeExecutionQueue = new Queue(QUEUE_NODE_EXECUTION, {
      connection: redisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _nodeExecutionQueue as Queue<NodeExecutionJobData>;
}

export function getInboundEmailQueue(): Queue<InboundEmailJobData> {
  if (!_inboundEmailQueue) {
    _inboundEmailQueue = new Queue(QUEUE_INBOUND_EMAIL, {
      connection: redisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return _inboundEmailQueue as Queue<InboundEmailJobData>;
}

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

/**
 * Enqueue a node-execution job.
 *
 * jobId uses | as separator (BullMQ v5 disallows : in custom jobIds).
 * BullMQ deduplicates on jobId within the active+waiting set, so a duplicate
 * enqueue from a retrying producer is a no-op.
 */
export async function enqueueNodeExecution(
  data: NodeExecutionJobData,
): Promise<void> {
  const queue = getNodeExecutionQueue();
  const jobId = `node-exec|${data.instanceId}|${data.expectedState}|${data.triggerRef}`;
  await queue.add("advance", data, { jobId });
}

/**
 * Enqueue an inbound-email job.
 *
 * jobId uses | as separator (BullMQ v5 disallows : in custom jobIds).
 * Guarantees exactly one processing attempt per unique inbound message even if
 * the producer retries.
 */
export async function enqueueInboundEmail(
  data: InboundEmailJobData,
): Promise<void> {
  const queue = getInboundEmailQueue();
  const jobId = `inbound|${data.externalMessageId}`;
  await queue.add("reply", data, { jobId });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export async function closeQueues(): Promise<void> {
  await Promise.all([
    _nodeExecutionQueue?.close(),
    _inboundEmailQueue?.close(),
  ]);
}
