import type { Job } from "bullmq";
import { recordDeadLetter } from "../db/index.js";
import type { JsonValue } from "../db/schema.js";

// ---------------------------------------------------------------------------
// BUG-Q1: dead-letter an exhausted BullMQ job.
// ---------------------------------------------------------------------------
// Called from a worker's on("failed") handler. BullMQ fires "failed" on EVERY
// failed attempt, not just the last — so we only dead-letter when the job has
// EXHAUSTED its configured attempts (nothing left to retry). At that point the
// job would otherwise vanish (removeOnFail eviction) with only a console.error;
// instead we persist it durably so it can be inspected and re-driven.
//
// Never throws: a dead-letter failure must not crash the worker's event loop.

/** True when this failed attempt was the job's LAST (no retry remains). */
export function isExhausted(job: Job | undefined): boolean {
  if (!job) return false;
  const attempts = job.opts?.attempts ?? 1;
  // attemptsMade is incremented to include the attempt that just failed.
  return (job.attemptsMade ?? 0) >= attempts;
}

/** Best-effort extraction of the instanceId carried on the job payload. */
function instanceIdOf(job: Job): string | null {
  const data = job.data as unknown;
  if (data && typeof data === "object" && "instanceId" in data) {
    const v = (data as { instanceId?: unknown }).instanceId;
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * If `job` has exhausted its retries, persist it to the dead-letter store.
 * Idempotent (dedupe on queue+jobId in the DB) and non-throwing.
 */
export async function deadLetterIfExhausted(
  queue: string,
  job: Job | undefined,
  err: Error,
): Promise<void> {
  try {
    if (!job || !isExhausted(job)) return;
    await recordDeadLetter({
      queue,
      jobId: job.id ?? null,
      jobName: job.name ?? null,
      payload: (job.data ?? {}) as JsonValue,
      instanceId: instanceIdOf(job),
      failReason: err?.message ? err.message.slice(0, 2000) : null,
      attemptsMade: job.attemptsMade ?? 0,
    });
    console.error(
      `[dead-letter] ${queue} job ${job.id ?? "?"} exhausted ${job.attemptsMade ?? "?"} attempt(s) — recorded to DeadLetterJob for re-drive`,
    );
  } catch (dlErr) {
    // A DLQ write failure must never crash the worker. Log loudly; the job is
    // still visible in Redis until removeOnFail evicts it.
    console.error(
      `[dead-letter] FAILED to record exhausted ${queue} job ${job?.id ?? "?"}:`,
      dlErr instanceof Error ? dlErr.message : dlErr,
    );
  }
}
