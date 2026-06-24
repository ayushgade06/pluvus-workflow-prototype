import type { ExecutionInstance, InstanceState, Prisma } from "@prisma/client";
import { prisma } from "./client.js";

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
