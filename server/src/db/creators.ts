import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./drizzle.js";
import { creators, type Creator, type CreatorInsert } from "./schema.js";

export async function findCreatorById(id: string): Promise<Creator | null> {
  const rows = await db.select().from(creators).where(eq(creators.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findCreatorByEmail(email: string): Promise<Creator | null> {
  const rows = await db
    .select()
    .from(creators)
    .where(eq(creators.email, email))
    .limit(1);
  return rows[0] ?? null;
}

export async function listCreators(): Promise<Creator[]> {
  return db.select().from(creators).orderBy(asc(creators.name));
}

export async function createCreator(data: CreatorInsert): Promise<Creator> {
  const rows = await db.insert(creators).values(data).returning();
  return rows[0]!;
}

/**
 * Build the `update` half of an upsert so a re-import enriches an existing
 * creator: only optional fields (handle/platform/niche/metadata) that arrive
 * with a value are written, and never blanked. `name` is intentionally left
 * alone on update — the existing roster name wins over a CSV re-upload.
 */
function enrichUpdate(data: CreatorInsert): Partial<CreatorInsert> {
  const update: Partial<CreatorInsert> = {};
  if (data.handle != null) update.handle = data.handle;
  if (data.platform != null) update.platform = data.platform;
  if (data.niche != null) update.niche = data.niche;
  if (data.metadata != null) update.metadata = data.metadata;
  return update;
}

/** Upsert one creator keyed on the unique email. When there is nothing to
 *  enrich, the conflict branch re-asserts the email (a no-op write) so the
 *  statement still returns the existing row, matching Prisma upsert. */
async function upsertOne(
  client: typeof db,
  data: CreatorInsert,
): Promise<Creator> {
  const enrich = enrichUpdate(data);
  const set = Object.keys(enrich).length > 0 ? enrich : { email: data.email };
  const rows = await client
    .insert(creators)
    .values(data)
    .onConflictDoUpdate({ target: creators.email, set })
    .returning();
  return rows[0]!;
}

export async function upsertCreatorByEmail(data: CreatorInsert): Promise<Creator> {
  return upsertOne(db, data);
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
  rows: CreatorInsert[],
): Promise<BulkUpsertResult> {
  // Dedupe on lowercased email, preserving first-seen order, last value wins.
  const byEmail = new Map<string, CreatorInsert>();
  const order: string[] = [];
  for (const row of rows) {
    const key = row.email.toLowerCase();
    if (!byEmail.has(key)) order.push(key);
    byEmail.set(key, row);
  }

  const deduped = order.map((k) => byEmail.get(k)!);

  // Determine which emails already exist so we can report created vs. updated.
  const existing = await db
    .select({ email: creators.email })
    .from(creators)
    .where(inArray(creators.email, deduped.map((r) => r.email)));
  const existingSet = new Set(existing.map((e) => e.email.toLowerCase()));

  // Prisma used the array form of $transaction here; Drizzle's interactive
  // transaction gives the same all-or-nothing batch.
  const upserted = await db.transaction(async (tx) => {
    const out: Creator[] = [];
    for (const row of deduped) {
      out.push(await upsertOne(tx as unknown as typeof db, row));
    }
    return out;
  });

  let created = 0;
  let updated = 0;
  for (const key of order) {
    if (existingSet.has(key)) updated++;
    else created++;
  }

  return { creators: upserted, created, updated };
}
