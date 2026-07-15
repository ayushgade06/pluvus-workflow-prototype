import { eq, count } from "drizzle-orm";
import { db } from "./drizzle.js";
import { clicks, type Click } from "./schema.js";

// ---------------------------------------------------------------------------
// Click — one row per visit through a /t/:code redirect (Phase 2).
// ---------------------------------------------------------------------------

export async function recordClick(data: {
  partnershipId: string;
  referralCode: string;
  ip?: string | null;
  userAgent?: string | null;
  referer?: string | null;
}): Promise<Click> {
  const rows = await db
    .insert(clicks)
    .values({
      partnershipId: data.partnershipId,
      referralCode: data.referralCode,
      ip: data.ip ?? null,
      userAgent: data.userAgent ?? null,
      referer: data.referer ?? null,
    })
    .returning();
  return rows[0]!;
}

export async function countClicksByPartnership(partnershipId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(clicks)
    .where(eq(clicks.partnershipId, partnershipId));
  return Number(rows[0]?.n ?? 0);
}
