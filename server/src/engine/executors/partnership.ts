import { isUniqueViolation } from "../../db/errors.js";
import {
  appendEvent,
  findPartnershipByInstance,
  createPartnership,
  createObligation,
  generateReferralCode,
  listEventsByInstance,
  listObligationsByPartnership,
} from "../../db/index.js";
import type { ExecutionContext } from "../types.js";
import type { IEmailProvider } from "../providers.js";
import type { Partnership } from "../../db/schema.js";
import { sendOnce } from "./idempotentSend.js";
import { renderPartnershipWelcomeEmail } from "./partnershipWelcomeEmail.js";
import { resolveAgreedFee, firstNumber } from "./agreedFee.js";
import { resolveBrandName } from "../campaignContext.js";
import { paymentBaseUrl } from "./paymentEmail.js";

// ---------------------------------------------------------------------------
// Partnership minting (Phase 1)
// ---------------------------------------------------------------------------
// Called from both completion executors after the workflow reaches a terminal
// state. Idempotent: a BullMQ retry or re-submit must not mint a second row.
// Failures are swallowed — a failed mint never fails the payout submission.
// ---------------------------------------------------------------------------

const MAX_CODE_ATTEMPTS = 5;

/**
 * Build the tracking link for a referral code and campaign target URL.
 * Returns null when the campaign has no targetUrl.
 */
export function buildTrackingLink(
  targetUrl: string | null | undefined,
  hiddenParamKey: string,
  referralCode: string,
): string | null {
  if (!targetUrl) return null;
  try {
    const url = new URL(targetUrl);
    url.searchParams.set(hiddenParamKey, referralCode);
    return url.toString();
  } catch {
    return null;
  }
}

/** Human-readable description stamped on the auto-minted fixed-fee obligation. */
export const FEE_OBLIGATION_DESCRIPTION = "Agreed collaboration fee";

/**
 * Mint the fixed-fee Obligation for a partnership, at most once.
 *
 * A partnership has at most one auto-minted fee obligation (manual extras are
 * Phase-4+ future work), so we check for any existing obligation first and no-op
 * if one is present. A null/absent agreed fee mints nothing. Returns true when a
 * row was created, false when it was a no-op (already present, or no fee).
 * Shared by resolvePartnership (mint-time) and the backfill script.
 */
export async function mintFeeObligation(
  partnershipId: string,
  agreedFeeCents: number | null | undefined,
): Promise<boolean> {
  // No fee, or a zero/negative fee, owes nothing — mint no obligation. Guarding
  // > 0 (not just null/undefined) stops a commission-only deal whose fixed fee
  // resolved to 0 from minting a $0.00 payable obligation, which would later
  // become a spurious "you've been paid $0.00" payout the creator must action.
  if (agreedFeeCents === null || agreedFeeCents === undefined) return false;
  if (!Number.isFinite(agreedFeeCents) || agreedFeeCents <= 0) return false;
  const existing = await listObligationsByPartnership(partnershipId);
  if (existing.length > 0) return false;
  await createObligation({
    partnershipId,
    description: FEE_OBLIGATION_DESCRIPTION,
    amountCents: agreedFeeCents,
  });
  return true;
}

/**
 * Resolve (or reuse) the Partnership for this instance. Idempotent.
 *
 * Returns the partnership row (existing or newly minted), or null on failure
 * (callers log and continue — I-8 posture: attribution failures never break
 * the product path).
 */
export async function resolvePartnership(
  ctx: ExecutionContext,
  email: IEmailProvider,
): Promise<Partnership | null> {
  const { instance, creator, nodeGraph, campaign } = ctx;

  // Step 1: already minted? Return it (idempotency).
  const existing = await findPartnershipByInstance(instance.id);
  if (existing) return existing;

  // Step 2: resolve money terms from the persisted PAYMENT_INFO_SENT event (I-2).
  // That event carries fixedFee + commission, stamped by executeContentBrief /
  // executePaymentInfo at send time. Fall back to re-deriving only when absent
  // (direct-created test instances, legacy graphs).
  let fixedFee: number | undefined;
  let commissionRate: number | undefined;

  const paymentInfoEvents = await listEventsByInstance(instance.id, {
    type: "PAYMENT_INFO_SENT",
  });
  const piEvent = paymentInfoEvents[0];
  if (piEvent?.payload && typeof piEvent.payload === "object" && !Array.isArray(piEvent.payload)) {
    const p = piEvent.payload as Record<string, unknown>;
    if (typeof p["fixedFee"] === "number") fixedFee = p["fixedFee"] as number;
    if (typeof p["commission"] === "number") commissionRate = p["commission"] as number;
  }

  if (fixedFee === undefined) {
    // Fallback: re-derive from NEGOTIATION_TURN history + config.
    const negotiationConfig =
      nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
    const events = await listEventsByInstance(instance.id, {
      type: "NEGOTIATION_TURN",
    });
    fixedFee = resolveAgreedFee(events, negotiationConfig, {});
  }
  if (commissionRate === undefined) {
    const negotiationConfig =
      nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
    const cbConfig =
      nodeGraph.find((n) => n.type === "CONTENT_BRIEF")?.config ?? {};
    commissionRate = firstNumber(
      cbConfig["commissionRate"],
      negotiationConfig["commissionRate"],
    );
  }

  const agreedFeeCents =
    fixedFee !== undefined ? Math.round(fixedFee * 100) : null;

  // Step 3: resolve campaign tracking params.
  const targetUrl = campaign?.targetUrl ?? null;
  const hiddenParamKey = campaign?.hiddenParamKey ?? "_from";

  // Step 4: mint (with collision retry) or re-read on concurrent unique violation (I-3).
  let partnership: Partnership;
  try {
    partnership = await mintWithRetry(
      creator.name,
      instance.id,
      campaign?.id ?? null,
      creator.id,
      targetUrl,
      hiddenParamKey,
      commissionRate ?? null,
      agreedFeeCents,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A concurrent path already created the row (instanceId unique) — re-read.
      const reread = await findPartnershipByInstance(instance.id);
      if (reread) {
        partnership = reread;
      } else {
        console.error("[partnership] resolvePartnership: concurrent insert conflict, re-read returned null", err);
        return null;
      }
    } else {
      console.error("[partnership] resolvePartnership: mint failed", err);
      return null;
    }
  }

  // Step 5: append PARTNERSHIP_ACTIVATED event (I-7).
  try {
    await appendEvent({
      instanceId: instance.id,
      type: "PARTNERSHIP_ACTIVATED",
      payload: {
        referralCode: partnership.referralCode,
        trackingLink: partnership.trackingLink ?? null,
        commissionRate: partnership.commissionRate ?? null,
        agreedFeeCents: partnership.agreedFeeCents ?? null,
      },
    });
  } catch (err) {
    console.error("[partnership] PARTNERSHIP_ACTIVATED event append failed (non-fatal)", err);
  }

  // Step 5.5: mint the fixed-fee Obligation (Phase 3). A partnership with an
  // agreed fee owes it; the Obligation is the ledger row the brand later pays as
  // a FIXED_FEE payout. Idempotent + non-fatal — a failed mint must never fail
  // the payout submission (I-8), and a re-run must not create a second row.
  try {
    await mintFeeObligation(partnership.id, partnership.agreedFeeCents);
  } catch (err) {
    console.error("[partnership] fee obligation mint failed (non-fatal)", err);
  }

  // Step 6: send the welcome email (idempotent, I-6).
  try {
    const brandName = resolveBrandName(
      nodeGraph.find((n) => n.type === "CONTENT_BRIEF")?.config ??
        nodeGraph.find((n) => n.type === "PAYMENT_INFO")?.config ??
        {},
      campaign,
    ) ?? (campaign?.brand ?? "Your brand");

    const cbConfig =
      nodeGraph.find((n) => n.type === "CONTENT_BRIEF")?.config ??
      nodeGraph.find((n) => n.type === "PAYMENT_INFO")?.config ??
      {};
    const senderName =
      typeof cbConfig["senderName"] === "string"
        ? (cbConfig["senderName"] as string)
        : brandName;

    const draft = renderPartnershipWelcomeEmail({
      creatorName: creator.name,
      brandName,
      senderName,
      trackingLink: partnership.trackingLink,
      agreedFeeCents: partnership.agreedFeeCents,
      commissionRate: partnership.commissionRate,
    });

    await sendOnce(
      email,
      instance.id,
      creator,
      draft,
      `partnership:welcome:${instance.id}`,
    );
  } catch (err) {
    console.error("[partnership] welcome email failed (non-fatal)", err);
  }

  return partnership;
}

// Internal helper that does the full retry loop building the tracking link
// per attempt (code changes each attempt so the link must change too).
async function mintWithRetry(
  creatorName: string,
  instanceId: string,
  campaignId: string | null,
  creatorId: string,
  targetUrl: string | null,
  hiddenParamKey: string,
  commissionRate: number | null,
  agreedFeeCents: number | null,
): Promise<Partnership> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateReferralCode(creatorName);
    const trackingLink = buildTrackingLink(targetUrl, hiddenParamKey, code);
    try {
      return await createPartnership({
        instanceId,
        campaignId,
        creatorId,
        referralCode: code,
        trackingLink,
        commissionRate,
        agreedFeeCents,
      });
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_CODE_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  throw new Error("exhausted referral code attempts");
}
