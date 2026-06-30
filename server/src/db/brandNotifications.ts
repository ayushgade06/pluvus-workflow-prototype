import type { BrandNotification, BrandNotificationStatus, Prisma } from "@prisma/client";
import { prisma } from "./client.js";

// ---------------------------------------------------------------------------
// BrandNotification — manual-queue escalation notices sent to the brand.
// ---------------------------------------------------------------------------
// One row per escalation event. The unique idempotencyKey (instanceId + reason)
// is the at-most-once guard: the create() below uses it as a reserve lock so a
// BullMQ retry of the same step never double-emails the brand.

export async function createBrandNotification(
  data: Prisma.BrandNotificationCreateInput,
): Promise<BrandNotification> {
  return prisma.brandNotification.create({ data });
}

export async function findBrandNotificationByKey(
  idempotencyKey: string,
): Promise<BrandNotification | null> {
  return prisma.brandNotification.findUnique({ where: { idempotencyKey } });
}

export async function updateBrandNotificationStatus(
  id: string,
  data: { status: BrandNotificationStatus; error?: string | null },
): Promise<BrandNotification> {
  return prisma.brandNotification.update({
    where: { id },
    data: { status: data.status, ...(data.error !== undefined ? { error: data.error } : {}) },
  });
}

/** Latest notification for an instance, if any. Used by the manual-queue UI to
 *  show whether (and how) the brand was reached for this escalation. */
export async function findLatestBrandNotificationForInstance(
  instanceId: string,
): Promise<BrandNotification | null> {
  return prisma.brandNotification.findFirst({
    where: { instanceId },
    orderBy: { createdAt: "desc" },
  });
}

/** Latest notification per instance for a set of instances (one query).
 *  Returns a Map keyed by instanceId. */
export async function listLatestBrandNotificationsForInstances(
  instanceIds: string[],
): Promise<Map<string, BrandNotification>> {
  if (instanceIds.length === 0) return new Map();
  // Ordered newest-first so the first row seen per instance is the latest.
  const rows = await prisma.brandNotification.findMany({
    where: { instanceId: { in: instanceIds } },
    orderBy: { createdAt: "desc" },
  });
  const map = new Map<string, BrandNotification>();
  for (const r of rows) {
    if (!map.has(r.instanceId)) map.set(r.instanceId, r);
  }
  return map;
}
