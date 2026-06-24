import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";
import type { NodeExecutionJobData, InboundEmailJobData } from "./jobs.js";

// ---------------------------------------------------------------------------
// Queue names — single source of truth
// ---------------------------------------------------------------------------

export const QUEUE_NODE_EXECUTION = "node-execution";
export const QUEUE_INBOUND_EMAIL = "inbound-email";

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
 * jobId = `node-exec:<instanceId>:<expectedState>:<triggerRef>`
 * BullMQ deduplicates on jobId within the active+waiting set, so a duplicate
 * enqueue from a retrying producer is a no-op.
 */
export async function enqueueNodeExecution(
  data: NodeExecutionJobData,
): Promise<void> {
  const queue = getNodeExecutionQueue();
  const jobId = `node-exec:${data.instanceId}:${data.expectedState}:${data.triggerRef}`;
  await queue.add("advance", data, { jobId });
}

/**
 * Enqueue an inbound-email job.
 *
 * jobId = `inbound:<externalMessageId>`
 * Guarantees exactly one processing attempt per unique inbound message even if
 * the producer retries.
 */
export async function enqueueInboundEmail(
  data: InboundEmailJobData,
): Promise<void> {
  const queue = getInboundEmailQueue();
  const jobId = `inbound:${data.externalMessageId}`;
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
