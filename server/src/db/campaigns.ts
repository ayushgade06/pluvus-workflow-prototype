import type { Campaign, Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export async function findCampaignById(id: string): Promise<Campaign | null> {
  return prisma.campaign.findUnique({ where: { id } });
}

export async function listCampaigns(): Promise<
  (Campaign & { _count: { workflows: number } })[]
> {
  return prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { workflows: true } } },
  });
}

export async function createCampaign(
  data: Prisma.CampaignCreateInput,
): Promise<Campaign> {
  return prisma.campaign.create({ data });
}

export async function updateCampaign(
  id: string,
  data: Prisma.CampaignUpdateInput,
): Promise<Campaign> {
  return prisma.campaign.update({ where: { id }, data });
}

export async function deleteCampaign(id: string): Promise<void> {
  // Delete all dependent records first (cascade order)
  const workflows = await prisma.workflow.findMany({
    where: { campaignId: id },
    select: { id: true },
  });
  const workflowIds = workflows.map((w) => w.id);

  if (workflowIds.length > 0) {
    const versions = await prisma.workflowVersion.findMany({
      where: { workflowId: { in: workflowIds } },
      select: { id: true },
    });
    const versionIds = versions.map((v) => v.id);

    const instances = await prisma.executionInstance.findMany({
      where: { workflowVersionId: { in: versionIds } },
      select: { id: true },
    });
    const instanceIds = instances.map((i) => i.id);

    if (instanceIds.length > 0) {
      await prisma.event.deleteMany({ where: { instanceId: { in: instanceIds } } });
      await prisma.message.deleteMany({ where: { instanceId: { in: instanceIds } } });
      await prisma.executionInstance.deleteMany({ where: { id: { in: instanceIds } } });
    }

    await prisma.workflowVersion.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.workflow.deleteMany({ where: { id: { in: workflowIds } } });
  }

  await prisma.campaign.delete({ where: { id } });
}

export async function getCampaignWithWorkflows(id: string) {
  return prisma.campaign.findUnique({
    where: { id },
    include: {
      workflows: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { versions: true } },
        },
      },
    },
  });
}
