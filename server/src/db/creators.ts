import { asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
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
    .where(eq(creators.email, normalizeEmail(email)))
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
 * The single definition of a creator's identity key.
 *
 * The DB unique index (Creator_email_key) is on the raw TEXT column, so it is
 * case-SENSITIVE. Before PLU-109 the bulk path deduped on a lowercased key in
 * JS but inserted the original string: "Jane@x.com" arriving when "jane@x.com"
 * already existed missed the conflict branch entirely and created a SECOND
 * creator for the same person — silent roster corruption that compounded with
 * every re-upload. Normalizing here, at every write and lookup, is what makes
 * the JS dedupe key and the DB index finally agree.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * How many rows go into one multi-row upsert statement.
 *
 * Bounded by Postgres's 65535 bind-parameter limit: ~20 columns per creator row
 * puts 500 rows at ~10k parameters, comfortably inside it while keeping a
 * 5,000-row import to 10 statements instead of 5,000.
 */
const UPSERT_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Shallow-merge an incoming JSONB value into the existing one, per top-level key.
 *
 * Merging matters because a creator is enriched by successive imports: a second
 * export carrying only TikTok columns must not wipe the Instagram block the
 * first one recorded. `||` is a shallow merge, which is exactly right here —
 * within one network the newer block replaces the older wholesale (it is a
 * fresher snapshot of the same metrics), while sibling networks are untouched.
 *
 * NULL is preserved rather than collapsing to '{}' when nothing new arrives.
 */
function mergeJson(column: PgColumn): SQL {
  return sql`CASE
    WHEN excluded.${sql.identifier(column.name)} IS NULL THEN ${column}
    ELSE COALESCE(${column}, '{}'::jsonb) || excluded.${sql.identifier(column.name)}
  END`;
}

/** Take the incoming value only when it is non-null; never blank an existing one. */
function preferIncoming(column: PgColumn): SQL {
  return sql`COALESCE(excluded.${sql.identifier(column.name)}, ${column})`;
}

/**
 * The `update` half of the upsert, as SQL rather than per-row JS.
 *
 * Expressed against `excluded` so ONE statement can enrich a whole chunk: each
 * row is merged against its own incoming values, which a per-row JS object
 * cannot express in a multi-row insert.
 *
 * `name` is deliberately inverted — the EXISTING roster name wins over a CSV
 * re-upload, because an operator who corrected a name by hand should not have
 * it clobbered by the next vendor export.
 */
const ENRICH_SET = {
  name: sql`COALESCE(${creators.name}, excluded."name")`,
  handle: preferIncoming(creators.handle),
  platform: preferIncoming(creators.platform),
  niche: preferIncoming(creators.niche),
  profileUrl: preferIncoming(creators.profileUrl),
  followerCount: preferIncoming(creators.followerCount),
  engagementRate: preferIncoming(creators.engagementRate),
  location: preferIncoming(creators.location),
  language: preferIncoming(creators.language),
  bio: preferIncoming(creators.bio),
  metadata: mergeJson(creators.metadata),
  socialLinks: mergeJson(creators.socialLinks),
  platformStats: mergeJson(creators.platformStats),
  signals: mergeJson(creators.signals),
  updatedAt: sql`CURRENT_TIMESTAMP`,
} as const;

export async function upsertCreatorByEmail(data: CreatorInsert): Promise<Creator> {
  const rows = await db
    .insert(creators)
    .values({ ...data, email: normalizeEmail(data.email) })
    .onConflictDoUpdate({ target: creators.email, set: ENRICH_SET })
    .returning();
  return rows[0]!;
}

export interface BulkUpsertResult {
  /** Creators after upsert, in the same order as the input rows (deduped). */
  creators: Creator[];
  created: number;
  updated: number;
  /** Emails that already existed before this call, lowercased. */
  existingEmails: Set<string>;
}

/**
 * Upsert many creators by email. Rows are deduped on the normalized email
 * (first-seen order, last value wins) before hitting the DB, so a file
 * containing the same address twice collapses to one upsert.
 *
 * Callers must validate each row's email first; this assumes every row has a
 * non-empty, well-formed one.
 */
export async function bulkUpsertCreators(
  rows: CreatorInsert[],
): Promise<BulkUpsertResult> {
  const byEmail = new Map<string, CreatorInsert>();
  const order: string[] = [];
  for (const row of rows) {
    const key = normalizeEmail(row.email);
    if (!byEmail.has(key)) order.push(key);
    byEmail.set(key, { ...row, email: key });
  }
  const deduped = order.map((k) => byEmail.get(k)!);

  if (deduped.length === 0) {
    return { creators: [], created: 0, updated: 0, existingEmails: new Set() };
  }

  // Which emails already exist, so we can report created vs. updated. Chunked
  // for the same bind-parameter reason as the upsert itself.
  const existingSet = new Set<string>();
  for (const part of chunk(deduped, UPSERT_CHUNK_SIZE)) {
    const found = await db
      .select({ email: creators.email })
      .from(creators)
      .where(inArray(creators.email, part.map((r) => r.email)));
    for (const e of found) existingSet.add(e.email.toLowerCase());
  }

  // One transaction so a failed chunk rolls the whole import back — a partially
  // applied batch would leave the audit counts lying about what was written.
  const upserted = await db.transaction(async (tx) => {
    const out: Creator[] = [];
    for (const part of chunk(deduped, UPSERT_CHUNK_SIZE)) {
      const returned = await tx
        .insert(creators)
        .values(part)
        .onConflictDoUpdate({ target: creators.email, set: ENRICH_SET })
        .returning();
      out.push(...returned);
    }
    return out;
  });

  // RETURNING order is not guaranteed to match the input, so re-order by email.
  const resultByEmail = new Map(upserted.map((c) => [c.email.toLowerCase(), c]));
  const ordered = order.map((k) => resultByEmail.get(k)).filter((c): c is Creator => !!c);

  let created = 0;
  let updated = 0;
  for (const key of order) {
    if (existingSet.has(key)) updated++;
    else created++;
  }

  return { creators: ordered, created, updated, existingEmails: existingSet };
}
