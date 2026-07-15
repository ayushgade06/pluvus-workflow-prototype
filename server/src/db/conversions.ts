import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  clicks,
  conversions,
  type Click,
  type Conversion,
  type JsonValue,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Conversion — one row per attributed product event (signup or payment),
// keyed by externalId for idempotency (I-3). Phase 2.
// ---------------------------------------------------------------------------

export async function createConversion(data: {
  partnershipId?: string | null;
  referralCode?: string | null;
  externalId: string;
  valueCents: number;
  currency?: string;
  commissionCents: number;
  customerEmail?: string | null;
  metadata?: JsonValue | null;
}): Promise<Conversion> {
  const rows = await db
    .insert(conversions)
    .values({
      partnershipId: data.partnershipId ?? null,
      referralCode: data.referralCode ?? null,
      externalId: data.externalId,
      valueCents: data.valueCents,
      currency: data.currency ?? "USD",
      commissionCents: data.commissionCents,
      customerEmail: data.customerEmail ?? null,
      metadata: data.metadata ?? null,
      payoutId: null,
      refunded: false,
    })
    .returning();
  return rows[0]!;
}

export async function findConversionByExternalId(
  externalId: string,
): Promise<Conversion | null> {
  const rows = await db
    .select()
    .from(conversions)
    .where(eq(conversions.externalId, externalId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listConversionsByPartnership(
  partnershipId: string,
  opts?: { limit?: number },
): Promise<Conversion[]> {
  const q = db
    .select()
    .from(conversions)
    .where(eq(conversions.partnershipId, partnershipId))
    .orderBy(desc(conversions.attributedAt));
  return opts?.limit ? q.limit(opts.limit) : q;
}

/** Unpaid, non-refunded conversions with a positive commission — Phase 3 payout source. */
export async function unpaidCommissionConversions(
  partnershipId: string,
): Promise<Conversion[]> {
  return db
    .select()
    .from(conversions)
    .where(
      and(
        eq(conversions.partnershipId, partnershipId),
        isNull(conversions.payoutId),
        eq(conversions.refunded, false),
        sql`${conversions.commissionCents} > 0`,
      ),
    );
}

export async function markConversionRefunded(id: string): Promise<Conversion> {
  const rows = await db
    .update(conversions)
    .set({ refunded: true })
    .where(eq(conversions.id, id))
    .returning();
  return rows[0]!;
}

export interface PartnershipMetrics {
  clicks: number;
  conversions: number;
  revenueCents: number;
  earnedCents: number;
  unpaidCents: number;
  paidCents: number;
}

/**
 * Aggregated attribution metrics for a single partnership. Single grouped query.
 *
 * - clicks        = total click rows
 * - conversions   = non-refunded attributed conversions
 * - revenueCents  = sum of valueCents (non-refunded)
 * - earnedCents   = sum of commissionCents (non-refunded)
 * - unpaidCents   = earnedCents where payoutId IS NULL
 * - paidCents     = earnedCents where payoutId IS NOT NULL
 */
export async function partnershipMetrics(
  partnershipId: string,
): Promise<PartnershipMetrics> {
  const [clickRow, convRow] = await Promise.all([
    db
      .select({ n: count() })
      .from(clicks)
      .where(eq(clicks.partnershipId, partnershipId)),
    db
      .select({
        conversions: count(),
        revenueCents: sql<number>`coalesce(sum(${conversions.valueCents}) filter (where ${conversions.refunded} = false), 0)`,
        earnedCents: sql<number>`coalesce(sum(${conversions.commissionCents}) filter (where ${conversions.refunded} = false), 0)`,
        unpaidCents: sql<number>`coalesce(sum(${conversions.commissionCents}) filter (where ${conversions.refunded} = false and ${conversions.payoutId} is null), 0)`,
        paidCents: sql<number>`coalesce(sum(${conversions.commissionCents}) filter (where ${conversions.refunded} = false and ${conversions.payoutId} is not null), 0)`,
      })
      .from(conversions)
      .where(eq(conversions.partnershipId, partnershipId)),
  ]);

  return {
    clicks: Number(clickRow[0]?.n ?? 0),
    conversions: Number(convRow[0]?.conversions ?? 0),
    revenueCents: Number(convRow[0]?.revenueCents ?? 0),
    earnedCents: Number(convRow[0]?.earnedCents ?? 0),
    unpaidCents: Number(convRow[0]?.unpaidCents ?? 0),
    paidCents: Number(convRow[0]?.paidCents ?? 0),
  };
}
