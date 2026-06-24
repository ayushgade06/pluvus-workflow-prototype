import type { Workflow, WorkflowVersion, Prisma } from "@prisma/client";
import { prisma } from "./client.js";

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function findWorkflowById(id: string): Promise<Workflow | null> {
  return prisma.workflow.findUnique({ where: { id } });
}

export async function listWorkflows(): Promise<Workflow[]> {
  return prisma.workflow.findMany({ orderBy: { createdAt: "desc" } });
}

export async function createWorkflow(
  data: Prisma.WorkflowCreateInput,
): Promise<Workflow> {
  return prisma.workflow.create({ data });
}

export async function updateWorkflow(
  id: string,
  data: Prisma.WorkflowUpdateInput,
): Promise<Workflow> {
  return prisma.workflow.update({ where: { id }, data });
}

// ---------------------------------------------------------------------------
// WorkflowVersion
// ---------------------------------------------------------------------------

export async function findVersionById(id: string): Promise<WorkflowVersion | null> {
  return prisma.workflowVersion.findUnique({ where: { id } });
}

export async function findLatestVersion(
  workflowId: string,
): Promise<WorkflowVersion | null> {
  return prisma.workflowVersion.findFirst({
    where: { workflowId },
    orderBy: { version: "desc" },
  });
}

export async function listVersions(workflowId: string): Promise<WorkflowVersion[]> {
  return prisma.workflowVersion.findMany({
    where: { workflowId },
    orderBy: { version: "asc" },
  });
}

export async function createVersion(
  data: Prisma.WorkflowVersionCreateInput,
): Promise<WorkflowVersion> {
  return prisma.workflowVersion.create({ data });
}

/** Compute the next version number for a workflow. */
export async function nextVersionNumber(workflowId: string): Promise<number> {
  const latest = await findLatestVersion(workflowId);
  return latest ? latest.version + 1 : 1;
}
