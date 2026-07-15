import { count, desc, eq, inArray } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  brandNotifications,
  campaigns,
  events,
  executionInstances,
  messages,
  partnerships,
  paymentInfo,
  workflows,
  workflowVersions,
  type Campaign,
  type CampaignInsert,
  type WorkflowStatus,
} from "./schema.js";

export async function findCampaignById(id: string): Promise<Campaign | null> {
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listCampaigns(): Promise<
  (Campaign & { _count: { workflows: number } })[]
> {
  // Prisma's include._count, expressed as a LEFT JOIN + GROUP BY on the pk.
  const rows = await db
    .select({ campaign: campaigns, workflowCount: count(workflows.id) })
    .from(campaigns)
    .leftJoin(workflows, eq(workflows.campaignId, campaigns.id))
    .groupBy(campaigns.id)
    .orderBy(desc(campaigns.createdAt));
  return rows.map((r) => ({ ...r.campaign, _count: { workflows: r.workflowCount } }));
}

export async function createCampaign(data: CampaignInsert): Promise<Campaign> {
  const rows = await db.insert(campaigns).values(data).returning();
  return rows[0]!;
}

export async function updateCampaign(
  id: string,
  data: Partial<CampaignInsert>,
): Promise<Campaign> {
  const rows = await db
    .update(campaigns)
    .set(data)
    .where(eq(campaigns.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) {
    // Prisma threw P2025 here; callers resolve the campaign first.
    throw new Error(`Campaign ${id} not found`);
  }
  return updated;
}

export async function deleteCampaign(id: string): Promise<void> {
  // W-7: the whole cascade runs in ONE transaction. Previously each DELETE was a
  // separate statement, so a crash partway through left orphaned rows (e.g.
  // instances deleted but their workflow/campaign still present, or events
  // deleted while the instances they belonged to survived) — an inconsistent
  // graph that no later delete would clean up. Wrapping it means the campaign and
  // every dependent row disappear together or not at all.
  await db.transaction(async (tx) => {
    // Delete all dependent records first (cascade order).
    const wfRows = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.campaignId, id));
    const workflowIds = wfRows.map((w) => w.id);

    if (workflowIds.length > 0) {
      const versionRows = await tx
        .select({ id: workflowVersions.id })
        .from(workflowVersions)
        .where(inArray(workflowVersions.workflowId, workflowIds));
      const versionIds = versionRows.map((v) => v.id);

      const instanceRows =
        versionIds.length > 0
          ? await tx
              .select({ id: executionInstances.id })
              .from(executionInstances)
              .where(inArray(executionInstances.workflowVersionId, versionIds))
          : [];
      const instanceIds = instanceRows.map((i) => i.id);

      if (instanceIds.length > 0) {
        // Delete ALL rows that reference an instance before the instances
        // themselves, or the executionInstances delete hits a foreign-key
        // violation. Besides Event/Message, later phases added BrandNotification
        // and PaymentInfo — each with an instanceId FK — so they must be cleaned
        // up here too (omitting them was what broke campaign deletion).
        await tx.delete(events).where(inArray(events.instanceId, instanceIds));
        await tx.delete(messages).where(inArray(messages.instanceId, instanceIds));
        await tx
          .delete(brandNotifications)
          .where(inArray(brandNotifications.instanceId, instanceIds));
        await tx.delete(paymentInfo).where(inArray(paymentInfo.instanceId, instanceIds));
        await tx
          .delete(partnerships)
          .where(inArray(partnerships.instanceId, instanceIds));
        await tx
          .delete(executionInstances)
          .where(inArray(executionInstances.id, instanceIds));
      }

      if (versionIds.length > 0) {
        await tx
          .delete(workflowVersions)
          .where(inArray(workflowVersions.workflowId, workflowIds));
      }
      await tx.delete(workflows).where(inArray(workflows.id, workflowIds));
    }

    await tx.delete(campaigns).where(eq(campaigns.id, id));
  });
}

export async function getCampaignWithWorkflows(id: string): Promise<
  | (Campaign & {
      workflows: Array<{
        id: string;
        name: string;
        status: WorkflowStatus;
        createdAt: Date;
        updatedAt: Date;
        _count: { versions: number };
      }>;
    })
  | null
> {
  const campaign = await findCampaignById(id);
  if (!campaign) return null;

  const wfRows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      status: workflows.status,
      createdAt: workflows.createdAt,
      updatedAt: workflows.updatedAt,
      versionCount: count(workflowVersions.id),
    })
    .from(workflows)
    .leftJoin(workflowVersions, eq(workflowVersions.workflowId, workflows.id))
    .where(eq(workflows.campaignId, id))
    .groupBy(workflows.id)
    .orderBy(desc(workflows.createdAt));

  return {
    ...campaign,
    workflows: wfRows.map(({ versionCount, ...w }) => ({
      ...w,
      _count: { versions: versionCount },
    })),
  };
}
