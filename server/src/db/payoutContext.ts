import { eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  campaigns,
  creators,
  paymentInfo,
  partnerships,
} from "./schema.js";

// ---------------------------------------------------------------------------
// PayoutContext — the joined read the payout routes/emails need (Phase 3).
// ---------------------------------------------------------------------------
// A payout hangs off a Partnership, which points at an ExecutionInstance,
// Creator, and (optionally) a Campaign; the copied payout destination comes from
// that instance's PaymentInfo. Both the brand-side routes (method/destination to
// copy, brand recipient) and the creator-side routes (creator name, brand name,
// dispute recipient) resolve from this one shape.

export interface PayoutContext {
  partnershipId: string;
  instanceId: string;
  creatorName: string;
  creatorEmail: string;
  /** Brand display name (campaign.brand), or null when no campaign is linked. */
  brandName: string | null;
  /** Per-campaign escalation recipient override, or null. */
  campaignNotifyEmail: string | null;
  /** Payout destination copied at creation (I-2) — from PaymentInfo. */
  paymentMethod: (typeof paymentInfo.$inferSelect)["method"];
  paymentAccountIdentifier: string | null;
}

/** Load the payout context for a partnership id, or null when unknown. */
export async function loadPayoutContextByPartnership(
  partnershipId: string,
): Promise<PayoutContext | null> {
  const rows = await db
    .select({
      partnershipId: partnerships.id,
      instanceId: partnerships.instanceId,
      creatorName: creators.name,
      creatorEmail: creators.email,
      brandName: campaigns.brand,
      campaignNotifyEmail: campaigns.notifyEmail,
      paymentMethod: paymentInfo.method,
      paymentAccountIdentifier: paymentInfo.accountIdentifier,
    })
    .from(partnerships)
    .innerJoin(creators, eq(partnerships.creatorId, creators.id))
    .leftJoin(campaigns, eq(partnerships.campaignId, campaigns.id))
    .leftJoin(paymentInfo, eq(paymentInfo.instanceId, partnerships.instanceId))
    .where(eq(partnerships.id, partnershipId))
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  return {
    partnershipId: r.partnershipId,
    instanceId: r.instanceId,
    creatorName: r.creatorName,
    creatorEmail: r.creatorEmail,
    brandName: r.brandName ?? null,
    campaignNotifyEmail: r.campaignNotifyEmail ?? null,
    paymentMethod: r.paymentMethod ?? null,
    paymentAccountIdentifier: r.paymentAccountIdentifier ?? null,
  };
}
