import type { ExecutionInstance, InstanceState, Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { Prisma as PrismaLib } from "@prisma/client";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function findInstanceById(id: string): Promise<ExecutionInstance | null> {
  return prisma.executionInstance.findUnique({ where: { id } });
}

export async function findInstanceByCreatorAndVersion(
  creatorId: string,
  workflowVersionId: string,
): Promise<ExecutionInstance | null> {
  return prisma.executionInstance.findUnique({
    where: { workflowVersionId_creatorId: { workflowVersionId, creatorId } },
  });
}

export async function listInstancesByVersion(
  workflowVersionId: string,
): Promise<ExecutionInstance[]> {
  return prisma.executionInstance.findMany({
    where: { workflowVersionId },
    orderBy: { enrolledAt: "asc" },
  });
}

export async function listInstancesByState(
  state: InstanceState,
): Promise<ExecutionInstance[]> {
  return prisma.executionInstance.findMany({
    where: { currentState: state },
    orderBy: { updatedAt: "asc" },
  });
}

/** Returns per-node creator counts for the pipeline visualization. */
export async function countInstancesByNode(
  workflowVersionId: string,
): Promise<Array<{ currentNodeId: string | null; _count: number }>> {
  const rows = await prisma.executionInstance.groupBy({
    by: ["currentNodeId"],
    where: { workflowVersionId },
    _count: true,
  });
  return rows.map((r) => ({ currentNodeId: r.currentNodeId, _count: r._count }));
}

// ---------------------------------------------------------------------------
// Write  (workers are the only callers in Phase 3+; these are the hooks)
// ---------------------------------------------------------------------------

export async function createInstance(
  data: Prisma.ExecutionInstanceCreateInput,
): Promise<ExecutionInstance> {
  return prisma.executionInstance.create({ data });
}

export async function updateInstanceState(
  id: string,
  patch: Pick<
    Prisma.ExecutionInstanceUpdateInput,
    | "currentState"
    | "currentNodeId"
    | "followUpCount"
    | "negotiationRound"
    | "dueAt"
    | "completedAt"
  >,
): Promise<ExecutionInstance> {
  return prisma.executionInstance.update({ where: { id }, data: patch });
}

/**
 * Optimistic concurrency control variant of updateInstanceState.
 *
 * Adds `currentState = expectedCurrentState` to the WHERE clause.
 * If the instance has already moved to a different state (concurrent worker),
 * Prisma throws P2025 (record not found) which the caller maps to null.
 *
 * Returns the updated instance, or null if the state no longer matches.
 */
export async function updateInstanceStateConditional(
  id: string,
  expectedCurrentState: InstanceState,
  patch: Pick<
    Prisma.ExecutionInstanceUpdateInput,
    | "currentState"
    | "currentNodeId"
    | "followUpCount"
    | "negotiationRound"
    | "dueAt"
    | "completedAt"
  >,
): Promise<ExecutionInstance | null> {
  try {
    return await prisma.executionInstance.update({
      where: { id, currentState: expectedCurrentState },
      data: patch,
    });
  } catch (err) {
    if (
      err instanceof PrismaLib.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return null; // state changed underneath us — OCC conflict
    }
    throw err;
  }
}

// HARD-R1: cap how many instances a single poll pulls, so a large backlog is
// drained in bounded batches (successive polls pick up the rest) rather than one
// unbounded query loading the whole table into memory at once.
const POLL_BATCH_LIMIT = 200;

/**
 * Returns instances whose dueAt is in the past and whose current state is one the
 * scheduler should act on (AWAITING_REPLY, FOLLOWED_UP). Used by the scheduler
 * poller every 30 s. Bounded by POLL_BATCH_LIMIT (HARD-R1) and index-backed by
 * the (currentState, dueAt) composite index.
 */
export async function listDueInstances(
  now: Date = new Date(),
): Promise<ExecutionInstance[]> {
  return prisma.executionInstance.findMany({
    where: {
      dueAt: { lte: now },
      currentState: { in: ["AWAITING_REPLY", "FOLLOWED_UP"] },
    },
    orderBy: { dueAt: "asc" },
    take: POLL_BATCH_LIMIT,
  });
}

// HARD-R1: the TRANSIENT non-terminal states — ones a crash/Redis blip between an
// OCC commit and the follow-on enqueue can strand invisibly. These are the states
// the reconciliation sweep re-enqueues. Deliberately EXCLUDES the legitimate
// WAITING states (AWAITING_REPLY/FOLLOWED_UP — covered by the due poller;
// REWARD_PENDING/PAYMENT_PENDING/AWAITING_BRAND_DECISION — parked on an external
// reply/form/brand): re-enqueuing those would spam, not recover.
const RECONCILE_STATES: InstanceState[] = [
  "ENROLLED",
  "OUTREACH_SENT",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "REWARD_CONFIRMED",
  "PAYMENT_RECEIVED",
];

/**
 * Returns instances stuck in a TRANSIENT non-terminal state whose last update is
 * older than `staleBefore` (HARD-R1 reconciliation sweep). An instance sitting in
 * one of these states well past the moment it should have auto-advanced was
 * almost certainly stranded by a crash between its state commit and the follow-on
 * job enqueue. Bounded by POLL_BATCH_LIMIT; index-backed by (currentState, dueAt).
 */
export async function listStuckInstances(
  staleBefore: Date,
): Promise<ExecutionInstance[]> {
  return prisma.executionInstance.findMany({
    where: {
      currentState: { in: RECONCILE_STATES },
      updatedAt: { lt: staleBefore },
    },
    orderBy: { updatedAt: "asc" },
    take: POLL_BATCH_LIMIT,
  });
}
