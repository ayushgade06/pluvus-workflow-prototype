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

/**
 * Build the `update` half of an upsert so a re-import enriches an existing
 * creator: only optional fields (handle/platform/niche/metadata) that arrive
 * with a value are written, and never blanked. `name` is intentionally left
 * alone on update — the existing roster name wins over a CSV re-upload.
 */
function enrichUpdate(data: Prisma.CreatorCreateInput): Prisma.CreatorUpdateInput {
  const update: Prisma.CreatorUpdateInput = {};
  if (data.handle != null) update.handle = data.handle;
  if (data.platform != null) update.platform = data.platform;
  if (data.niche != null) update.niche = data.niche;
  if (data.metadata != null) update.metadata = data.metadata;
  return update;
}

export async function upsertCreatorByEmail(
  data: Prisma.CreatorCreateInput,
): Promise<Creator> {
  return prisma.creator.upsert({
    where: { email: data.email },
    update: enrichUpdate(data),
    create: data,
  });
}

export interface BulkUpsertResult {
  /** Creators after upsert, in the same order as the input rows (deduped). */
  creators: Creator[];
  created: number;
  updated: number;
}

/**
 * Upsert many creators by email in a single transaction. Rows are deduped on
 * lowercased email (last write wins) before hitting the DB so a CSV containing
 * the same email twice collapses to one upsert. Returns the resulting creators
 * plus counts of how many were newly created vs. enriched.
 *
 * Callers are responsible for validating each row's email first; this function
 * assumes every row has a non-empty, well-formed email.
 */
export async function bulkUpsertCreators(
  rows: Prisma.CreatorCreateInput[],
): Promise<BulkUpsertResult> {
  // Dedupe on lowercased email, preserving first-seen order, last value wins.
  const byEmail = new Map<string, Prisma.CreatorCreateInput>();
  const order: string[] = [];
  for (const row of rows) {
    const key = row.email.toLowerCase();
    if (!byEmail.has(key)) order.push(key);
    byEmail.set(key, row);
  }

  const deduped = order.map((k) => byEmail.get(k)!);

  // Determine which emails already exist so we can report created vs. updated.
  const existing = await prisma.creator.findMany({
    where: { email: { in: deduped.map((r) => r.email) } },
    select: { email: true },
  });
  const existingSet = new Set(existing.map((e) => e.email.toLowerCase()));

  const creators = await prisma.$transaction(
    deduped.map((row) =>
      prisma.creator.upsert({
        where: { email: row.email },
        update: enrichUpdate(row),
        create: row,
      }),
    ),
  );

  let created = 0;
  let updated = 0;
  for (const key of order) {
    if (existingSet.has(key)) updated++;
    else created++;
  }

  return { creators, created, updated };
}
