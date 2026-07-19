import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  deadLetterJobs,
  type DeadLetterJob,
  type JsonValue,
} from "./schema.js";

// ---------------------------------------------------------------------------
// DeadLetterJob — durable store for BullMQ jobs that exhausted their retries.
// ---------------------------------------------------------------------------
// BUG-Q1: a worker's on("failed") handler records the final-failed job here so it
// survives a Redis eviction/flush; BUG-Q2: the inbound-email re-drive sweep reads
// PENDING rows and re-enqueues them so a lost creator reply is recoverable.

/**
 * Record an exhausted job in the dead-letter store. Idempotent on (queue, jobId):
 * if on("failed") fires more than once for the same job, the second insert hits
 * the partial unique index and is a safe no-op (returns the existing row's id, or
 * null when it can't be re-read). Jobs with no jobId are always inserted (no
 * dedupe key), which is acceptable — BullMQ jobs in this system always carry a
 * deterministic jobId.
 */
export async function recordDeadLetter(data: {
  queue: string;
  jobId: string | null;
  jobName: string | null;
  payload: JsonValue;
  instanceId: string | null;
  failReason: string | null;
  attemptsMade: number;
}): Promise<DeadLetterJob | null> {
  try {
    const rows = await db
      .insert(deadLetterJobs)
      .values({
        queue: data.queue,
        jobId: data.jobId,
        jobName: data.jobName,
        payload: data.payload,
        instanceId: data.instanceId,
        failReason: data.failReason,
        attemptsMade: data.attemptsMade,
        status: "PENDING",
      })
      .returning();
    return rows[0] ?? null;
  } catch (err) {
    // Already dead-lettered (partial unique on queue+jobId) — no-op.
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** PENDING dead-letter rows for a queue, oldest-first (the re-drive sweep source). */
export async function listPendingDeadLetters(
  queue: string,
  limit = 100,
): Promise<DeadLetterJob[]> {
  return db
    .select()
    .from(deadLetterJobs)
    .where(
      and(eq(deadLetterJobs.queue, queue), eq(deadLetterJobs.status, "PENDING")),
    )
    .orderBy(asc(deadLetterJobs.createdAt))
    .limit(limit);
}

/**
 * Mark a dead-letter row REDRIVEN (the sweep re-enqueued it). Guarded on PENDING
 * so two concurrent sweeps can't both claim it — the loser's update matches 0
 * rows and returns null, so only one re-enqueue happens per row.
 */
export async function markDeadLetterRedriven(
  id: string,
): Promise<DeadLetterJob | null> {
  const rows = await db
    .update(deadLetterJobs)
    .set({
      status: "REDRIVEN",
      redrivenAt: new Date(),
      redriveCount: sql`${deadLetterJobs.redriveCount} + 1`,
    })
    .where(and(eq(deadLetterJobs.id, id), eq(deadLetterJobs.status, "PENDING")))
    .returning();
  return rows[0] ?? null;
}

/** Operator action: mark a dead-letter row DISCARDED (won't be re-driven). */
export async function markDeadLetterDiscarded(
  id: string,
): Promise<DeadLetterJob | null> {
  const rows = await db
    .update(deadLetterJobs)
    .set({ status: "DISCARDED" })
    .where(and(eq(deadLetterJobs.id, id), eq(deadLetterJobs.status, "PENDING")))
    .returning();
  return rows[0] ?? null;
}

/** Count of PENDING dead-letter rows (optionally for one queue) — for alerting. */
export async function countPendingDeadLetters(queue?: string): Promise<number> {
  const where = queue
    ? and(eq(deadLetterJobs.status, "PENDING"), eq(deadLetterJobs.queue, queue))
    : eq(deadLetterJobs.status, "PENDING");
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(deadLetterJobs)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}
