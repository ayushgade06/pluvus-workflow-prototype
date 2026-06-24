import type { Worker } from "bullmq";
import { createNodeExecutionWorker } from "./nodeExecutionWorker.js";
import { createInboundEmailWorker } from "./inboundEmailWorker.js";
import { closeQueues } from "./queues.js";

export { enqueueNodeExecution, enqueueInboundEmail, getNodeExecutionQueue, getInboundEmailQueue } from "./queues.js";
export type { NodeExecutionJobData, InboundEmailJobData } from "./jobs.js";

// ---------------------------------------------------------------------------
// Worker registry
// ---------------------------------------------------------------------------

let _workers: Worker[] = [];

/**
 * Start all Phase 4 workers and register SIGTERM/SIGINT handlers for graceful
 * shutdown.  Call once at application startup (e.g., from index.ts).
 */
export function startWorkers(): void {
  if (_workers.length > 0) return; // idempotent

  const nodeExec = createNodeExecutionWorker();
  const inboundEmail = createInboundEmailWorker();
  _workers = [nodeExec, inboundEmail];

  console.log("[workers] node-execution worker started");
  console.log("[workers] inbound-email worker started");
}

/**
 * Stop all workers (useful in tests or programmatic teardown).
 */
export async function stopWorkers(): Promise<void> {
  await Promise.all(_workers.map((w) => w.close()));
  await closeQueues();
  _workers = [];
}
