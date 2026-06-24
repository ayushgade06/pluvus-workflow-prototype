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
