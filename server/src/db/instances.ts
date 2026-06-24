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

/**
 * Returns all instances whose dueAt is in the past and whose current state
 * is one that the scheduler should act on (AWAITING_REPLY, FOLLOWED_UP).
 * Used by the scheduler poller every 30 s.
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
  });
}
