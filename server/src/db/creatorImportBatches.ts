// ---------------------------------------------------------------------------
// Creator import batch queries (PLU-109)
// ---------------------------------------------------------------------------
// A batch is one CSV upload, kept as a first-class immutable record so that
// "yesterday's list" stays a distinct, re-selectable thing instead of
// dissolving into the global roster.

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  creatorImportBatchMembers,
  creatorImportBatches,
  creators,
  type Creator,
  type CreatorImportBatch,
  type CreatorImportBatchInsert,
  type CreatorImportBatchMember,
  type CreatorImportBatchMemberInsert,
} from "./schema.js";

/** Same bind-parameter ceiling reasoning as bulkUpsertCreators. */
const INSERT_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function createBatch(
  data: CreatorImportBatchInsert,
): Promise<CreatorImportBatch> {
  const rows = await db.insert(creatorImportBatches).values(data).returning();
  return rows[0]!;
}

export async function findBatchById(id: string): Promise<CreatorImportBatch | null> {
  const rows = await db
    .select()
    .from(creatorImportBatches)
    .where(eq(creatorImportBatches.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Batches for the source-list dropdown, newest first.
 * ARCHIVED batches are excluded by default — archiving hides a list from the
 * picker without destroying its audit trail.
 */
export async function listBatches(
  opts: { includeArchived?: boolean } = {},
): Promise<CreatorImportBatch[]> {
  const query = db.select().from(creatorImportBatches);
  const rows = opts.includeArchived
    ? await query.orderBy(desc(creatorImportBatches.createdAt))
    : await query
        .where(ne(creatorImportBatches.status, "ARCHIVED"))
        .orderBy(desc(creatorImportBatches.createdAt));
  return rows;
}

export async function insertMembers(
  rows: CreatorImportBatchMemberInsert[],
): Promise<void> {
  for (const part of chunk(rows, INSERT_CHUNK_SIZE)) {
    await db.insert(creatorImportBatchMembers).values(part);
  }
}

export async function listMembers(
  batchId: string,
): Promise<CreatorImportBatchMember[]> {
  return db
    .select()
    .from(creatorImportBatchMembers)
    .where(eq(creatorImportBatchMembers.batchId, batchId))
    .orderBy(asc(creatorImportBatchMembers.rowNumber));
}

export interface MemberWithCreator {
  member: CreatorImportBatchMember;
  creator: Creator | null;
}

/**
 * A batch's members joined to their creators, row order preserved.
 * This is what the enroll picker renders when a source list is selected: the
 * creator to enroll, plus the outcome that drives the NEW / DUPLICATE badge.
 */
export async function listMembersWithCreators(
  batchId: string,
): Promise<MemberWithCreator[]> {
  const members = await listMembers(batchId);
  const ids = [...new Set(members.map((m) => m.creatorId).filter((id): id is string => !!id))];

  const byId = new Map<string, Creator>();
  for (const part of chunk(ids, INSERT_CHUNK_SIZE)) {
    const rows = await db.select().from(creators).where(inArray(creators.id, part));
    for (const c of rows) byId.set(c.id, c);
  }

  return members.map((member) => ({
    member,
    creator: member.creatorId ? (byId.get(member.creatorId) ?? null) : null,
  }));
}

/**
 * For each creator id, the labels of every OTHER committed batch they appear in.
 *
 * This is what makes a duplicate visible before you click rather than after:
 * "Sam Lee — also in Jul 20 list". Only committed batches count, so an
 * abandoned draft never makes a creator look like a duplicate.
 */
export async function findOtherBatchLabels(
  creatorIds: string[],
  excludeBatchId: string,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (creatorIds.length === 0) return out;

  for (const part of chunk(creatorIds, INSERT_CHUNK_SIZE)) {
    const rows = await db
      .select({
        creatorId: creatorImportBatchMembers.creatorId,
        label: creatorImportBatches.label,
        createdAt: creatorImportBatches.createdAt,
      })
      .from(creatorImportBatchMembers)
      .innerJoin(
        creatorImportBatches,
        eq(creatorImportBatchMembers.batchId, creatorImportBatches.id),
      )
      .where(
        and(
          inArray(creatorImportBatchMembers.creatorId, part),
          ne(creatorImportBatchMembers.batchId, excludeBatchId),
          eq(creatorImportBatches.status, "COMMITTED"),
        ),
      )
      .orderBy(desc(creatorImportBatches.createdAt));

    for (const r of rows) {
      if (!r.creatorId) continue;
      const list = out.get(r.creatorId) ?? [];
      if (!list.includes(r.label)) list.push(r.label);
      out.set(r.creatorId, list);
    }
  }
  return out;
}

export interface MemberOutcomeUpdate {
  rowNumber: number;
  creatorId: string;
  outcome: "CREATED" | "UPDATED";
}

/**
 * Stamp commit results onto the draft's member rows, and finalize the batch.
 *
 * One transaction: the counts on the batch and the per-row outcomes are the
 * audit record, and a half-written one would misreport what the import did.
 */
export async function commitBatch(
  batchId: string,
  updates: MemberOutcomeUpdate[],
  counts: { createdCount: number; updatedCount: number; skippedCount: number },
): Promise<CreatorImportBatch> {
  return db.transaction(async (tx) => {
    for (const part of chunk(updates, INSERT_CHUNK_SIZE)) {
      // One UPDATE per chunk driven by a VALUES list, rather than one statement
      // per row — a 5,000-row commit is 10 statements, not 5,000.
      const values = sql.join(
        part.map(
          (u) =>
            sql`(${u.rowNumber}::int, ${u.creatorId}::text, ${u.outcome}::"ImportRowOutcome")`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE "CreatorImportBatchMember" AS m
        SET "creatorId" = v.creator_id, "outcome" = v.outcome
        FROM (VALUES ${values}) AS v(row_number, creator_id, outcome)
        WHERE m."batchId" = ${batchId} AND m."rowNumber" = v.row_number
      `);
    }

    const rows = await tx
      .update(creatorImportBatches)
      .set({
        status: "COMMITTED",
        committedAt: new Date(),
        createdCount: counts.createdCount,
        updatedCount: counts.updatedCount,
        skippedCount: counts.skippedCount,
      })
      .where(eq(creatorImportBatches.id, batchId))
      .returning();
    return rows[0]!;
  });
}

export async function updateBatch(
  id: string,
  patch: Partial<Pick<CreatorImportBatch, "label" | "status" | "archivedAt">>,
): Promise<CreatorImportBatch | null> {
  const rows = await db
    .update(creatorImportBatches)
    .set(patch)
    .where(eq(creatorImportBatches.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Delete a batch and (by cascade) its member rows. Never touches Creator. */
export async function deleteBatch(id: string): Promise<void> {
  await db.delete(creatorImportBatches).where(eq(creatorImportBatches.id, id));
}
