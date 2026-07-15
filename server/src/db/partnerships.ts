import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  campaigns,
  creators,
  partnerships,
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

export async function createPartnership(data: {
  instanceId: string;
  campaignId?: string | null;
  creatorId: string;
  referralCode: string;
  trackingLink?: string | null;
  commissionRate?: number | null;
  agreedFeeCents?: number | null;
}): Promise<Partnership> {
  const rows = await db
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
