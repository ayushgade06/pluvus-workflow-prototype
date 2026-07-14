import { asc, desc, eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  workflows,
  workflowVersions,
  type Workflow,
  type WorkflowInsert,
  type WorkflowVersion,
  type WorkflowVersionInsert,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function findWorkflowById(id: string): Promise<Workflow | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listWorkflows(): Promise<Workflow[]> {
  return db.select().from(workflows).orderBy(desc(workflows.createdAt));
}

export async function createWorkflow(data: WorkflowInsert): Promise<Workflow> {
  const rows = await db.insert(workflows).values(data).returning();
  return rows[0]!;
}

export async function updateWorkflow(
  id: string,
  data: Partial<WorkflowInsert>,
): Promise<Workflow> {
  const rows = await db
    .update(workflows)
    .set(data)
    .where(eq(workflows.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) {
    // Prisma threw P2025 here; callers resolve the workflow first.
    throw new Error(`Workflow ${id} not found`);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// WorkflowVersion
// ---------------------------------------------------------------------------

export async function findVersionById(id: string): Promise<WorkflowVersion | null> {
  const rows = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findLatestVersion(
  workflowId: string,
): Promise<WorkflowVersion | null> {
  const rows = await db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listVersions(workflowId: string): Promise<WorkflowVersion[]> {
  return db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(asc(workflowVersions.version));
}

export async function createVersion(
  data: WorkflowVersionInsert,
): Promise<WorkflowVersion> {
  const rows = await db.insert(workflowVersions).values(data).returning();
  return rows[0]!;
}

/** Compute the next version number for a workflow. */
export async function nextVersionNumber(workflowId: string): Promise<number> {
  const latest = await findLatestVersion(workflowId);
  return latest ? latest.version + 1 : 1;
}
