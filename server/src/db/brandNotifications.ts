import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  brandNotifications,
  type BrandNotification,
  type BrandNotificationInsert,
  type BrandNotificationStatus,
} from "./schema.js";

// ---------------------------------------------------------------------------
// BrandNotification — manual-queue escalation notices sent to the brand.
// ---------------------------------------------------------------------------
// One row per escalation event. The unique idempotencyKey (instanceId + reason)
// is the at-most-once guard: the create() below uses it as a reserve lock so a
// BullMQ retry of the same step never double-emails the brand.

export async function createBrandNotification(
  data: BrandNotificationInsert,
): Promise<BrandNotification> {
  const rows = await db.insert(brandNotifications).values(data).returning();
  return rows[0]!;
}

export async function findBrandNotificationByKey(
  idempotencyKey: string,
): Promise<BrandNotification | null> {
  const rows = await db
    .select()
    .from(brandNotifications)
    .where(eq(brandNotifications.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateBrandNotificationStatus(
  id: string,
  data: { status: BrandNotificationStatus; error?: string | null },
): Promise<BrandNotification> {
  const rows = await db
    .update(brandNotifications)
    .set({
      status: data.status,
      ...(data.error !== undefined ? { error: data.error } : {}),
    })
    .where(eq(brandNotifications.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) {
    // Prisma threw P2025 here; the row was just reserved by the caller.
    throw new Error(`BrandNotification ${id} not found`);
  }
  return updated;
}

/** Latest notification for an instance, if any. Used by the manual-queue UI to
 *  show whether (and how) the brand was reached for this escalation. */
export async function findLatestBrandNotificationForInstance(
  instanceId: string,
): Promise<BrandNotification | null> {
  const rows = await db
    .select()
    .from(brandNotifications)
    .where(eq(brandNotifications.instanceId, instanceId))
    .orderBy(desc(brandNotifications.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Latest notification per instance for a set of instances (one query).
 *  Returns a Map keyed by instanceId. */
export async function listLatestBrandNotificationsForInstances(
  instanceIds: string[],
): Promise<Map<string, BrandNotification>> {
  if (instanceIds.length === 0) return new Map();
  // Ordered newest-first so the first row seen per instance is the latest.
  const rows = await db
    .select()
    .from(brandNotifications)
    .where(inArray(brandNotifications.instanceId, instanceIds))
    .orderBy(desc(brandNotifications.createdAt));
  const map = new Map<string, BrandNotification>();
  for (const r of rows) {
    if (!map.has(r.instanceId)) map.set(r.instanceId, r);
  }
  return map;
}
