import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  campaigns,
  creators,
  obligations,
  partnerships,
  paymentInfo,
  payouts,
  type Partnership,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Partnership — one row per completed ExecutionInstance.
// Minted in the payout-form submission executors; carries the referral code,
// tracking link, and frozen money terms (I-1, I-2).
// ---------------------------------------------------------------------------

/**
 * Mint a unique referral code for a creator.
 *
 * Recipe from parent `Pluvus/server/routes/api/join.ts:144-151`:
 *   slug = name.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 12)
 *   code = `${slug}_${randomBytes(6).toString("hex")}`
 *
 * Not exported — callers use createPartnership which handles the retry loop.
 */
function generateReferralCode(creatorName: string): string {
  const slug = creatorName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .substring(0, 12);
  return `${slug}_${randomBytes(6).toString("hex")}`;
}

export type PartnershipWithJoins = Partnership & {
  creatorName: string;
  creatorEmail: string;
  campaignName: string | null;
};

// Phase 4: payout rollup added to the list and detail responses.
export interface PayoutRollup {
  /** Sum of PENDING obligation amounts (not yet converted to a payout). */
  unpaidFeeCents: number;
  /** Sum of commission on unpaid, non-refunded conversions (payoutId IS NULL). */
  unpaidCommissionCents: number;
  /** Sum of payouts currently in-flight (PENDING | SENT | DISPUTED). */
  inFlightCents: number;
  /** Sum of SETTLED payouts. */
  settledCents: number;
  /** True when at least one payout is DISPUTED. */
  hasDispute: boolean;
}

export type PartnershipWithRollup = PartnershipWithJoins & {
  rollup: PayoutRollup;
};

/**
 * One grouped-query rollup per partnership, keyed by partnershipId.
 *
 * Single SQL call joins obligations + payouts + conversions; the caller
 * iterates the result map with no further per-row queries (no N+1).
 */
export async function payoutRollupForPartnerships(
  partnershipIds: string[],
): Promise<Map<string, PayoutRollup>> {
  if (partnershipIds.length === 0) return new Map();

  // Obligation rollup: sum of PENDING (no payoutId) amounts per partnership.
  const obRows = await db
    .select({
      partnershipId: obligations.partnershipId,
      unpaidFeeCents: sql<number>`coalesce(sum(${obligations.amountCents}) filter (where ${obligations.status} = 'PENDING' and ${obligations.payoutId} is null), 0)`,
    })
    .from(obligations)
    .where(
      sql`${obligations.partnershipId} IN (${sql.join(
        partnershipIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    .groupBy(obligations.partnershipId);

  // Payout rollup: in-flight (PENDING|SENT|DISPUTED) + settled amounts + hasDispute.
  const payoutRows = await db
    .select({
      partnershipId: payouts.partnershipId,
      inFlightCents: sql<number>`coalesce(sum(${payouts.amountCents}) filter (where ${payouts.status} IN ('PENDING', 'SENT', 'DISPUTED')), 0)`,
      settledCents: sql<number>`coalesce(sum(${payouts.amountCents}) filter (where ${payouts.status} = 'SETTLED'), 0)`,
      hasDispute: sql<boolean>`bool_or(${payouts.status} = 'DISPUTED')`,
    })
    .from(payouts)
    .where(
      sql`${payouts.partnershipId} IN (${sql.join(
        partnershipIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    .groupBy(payouts.partnershipId);

  // Unpaid commission rollup from conversions (payoutId IS NULL, not refunded, commissionCents > 0).
  const convRows = await db
    .select({
      partnershipId: sql<string>`${partnerships.id}`,
      unpaidCommissionCents: sql<number>`coalesce(sum(c."commissionCents") filter (where c."payoutId" is null and c."refunded" = false and c."commissionCents" > 0), 0)`,
    })
    .from(partnerships)
    .leftJoin(
      sql`"Conversion" c`,
      sql`c."partnershipId" = ${partnerships.id}`,
    )
    .where(
      sql`${partnerships.id} IN (${sql.join(
        partnershipIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    .groupBy(partnerships.id);

  // Build a map indexed by partnershipId.
  const obMap = new Map(obRows.map((r) => [r.partnershipId, r]));
  const payoutMap = new Map(payoutRows.map((r) => [r.partnershipId, r]));
  const convMap = new Map(convRows.map((r) => [r.partnershipId, r]));

  const result = new Map<string, PayoutRollup>();
  for (const id of partnershipIds) {
    const ob = obMap.get(id);
    const py = payoutMap.get(id);
    const cv = convMap.get(id);
    result.set(id, {
      unpaidFeeCents: Number(ob?.unpaidFeeCents ?? 0),
      unpaidCommissionCents: Number(cv?.unpaidCommissionCents ?? 0),
      inFlightCents: Number(py?.inFlightCents ?? 0),
      settledCents: Number(py?.settledCents ?? 0),
      hasDispute: Boolean(py?.hasDispute ?? false),
    });
  }
  return result;
}

/**
 * PaymentInfo destination summary for a single instance (Phase 4 detail endpoint).
 * Reads method + accountIdentifier + extra (shipping) from the PaymentInfo row.
 */
export interface PaymentInfoSummary {
  method: string | null;
  accountIdentifier: string | null;
  shipping: unknown | null;
}

export async function findPaymentInfoSummaryByInstance(
  instanceId: string,
): Promise<PaymentInfoSummary | null> {
  const rows = await db
    .select({
      method: paymentInfo.method,
      accountIdentifier: paymentInfo.accountIdentifier,
      extra: paymentInfo.extra,
    })
    .from(paymentInfo)
    .where(eq(paymentInfo.instanceId, instanceId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const extra = r.extra as Record<string, unknown> | null;
  return {
    method: r.method ?? null,
    accountIdentifier: r.accountIdentifier ?? null,
    shipping: extra?.shipping ?? null,
  };
}

export async function createPartnership(
  data: {
    instanceId: string;
    campaignId?: string | null;
    creatorId: string;
    referralCode: string;
    trackingLink?: string | null;
    commissionRate?: number | null;
    agreedFeeCents?: number | null;
  },
  client: Db | DbTx = db,
): Promise<Partnership> {
  const rows = await client
    .insert(partnerships)
    .values({
      instanceId: data.instanceId,
      campaignId: data.campaignId ?? null,
      creatorId: data.creatorId,
      referralCode: data.referralCode,
      trackingLink: data.trackingLink ?? null,
      commissionRate: data.commissionRate ?? null,
      agreedFeeCents: data.agreedFeeCents ?? null,
      status: "ACTIVE",
    })
    .returning();
  return rows[0]!;
}

export async function findPartnershipByInstance(
  instanceId: string,
): Promise<Partnership | null> {
  const rows = await db
    .select()
    .from(partnerships)
    .where(eq(partnerships.instanceId, instanceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPartnershipByReferralCode(
  code: string,
): Promise<Partnership | null> {
  const rows = await db
    .select()
    .from(partnerships)
    .where(eq(partnerships.referralCode, code))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPartnerships(): Promise<PartnershipWithJoins[]> {
  const rows = await db
    .select({
      partnership: partnerships,
      creatorName: creators.name,
      creatorEmail: creators.email,
      campaignName: campaigns.name,
    })
    .from(partnerships)
    .innerJoin(creators, eq(partnerships.creatorId, creators.id))
    .leftJoin(campaigns, eq(partnerships.campaignId, campaigns.id))
    .orderBy(partnerships.createdAt);

  return rows.map((r) => ({
    ...r.partnership,
    creatorName: r.creatorName,
    creatorEmail: r.creatorEmail,
    campaignName: r.campaignName ?? null,
  }));
}

export { generateReferralCode };
