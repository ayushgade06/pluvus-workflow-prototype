import type { Creator, Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export async function findCreatorById(id: string): Promise<Creator | null> {
  return prisma.creator.findUnique({ where: { id } });
}

export async function findCreatorByEmail(email: string): Promise<Creator | null> {
  return prisma.creator.findUnique({ where: { email } });
}

export async function listCreators(): Promise<Creator[]> {
  return prisma.creator.findMany({ orderBy: { name: "asc" } });
}

export async function createCreator(data: Prisma.CreatorCreateInput): Promise<Creator> {
  return prisma.creator.create({ data });
}

export async function upsertCreatorByEmail(
  data: Prisma.CreatorCreateInput,
): Promise<Creator> {
  return prisma.creator.upsert({
    where: { email: data.email },
    update: {},
    create: data,
  });
}
