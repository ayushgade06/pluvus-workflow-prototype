import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import {
  appendEvent,
  createConversion,
  findConversionByExternalId,
  findPartnershipByReferralCode,
  isUniqueViolation,
  markConversionRefunded,
} from "../db/index.js";
import {
  conversionBodySchema,
  resolveValueCents,
  computeCommissionCents,
} from "./attributionLogic.js";

// ---------------------------------------------------------------------------
// Attribution webhook: POST /attribution/conversion
// Refund endpoint:    POST /attribution/conversion/:externalId/refund
//
// Called server-to-server by our own product when a referred user converts.
// Auth: constant-time header check against ATTRIBUTION_WEBHOOK_SECRET (I-8).
// ---------------------------------------------------------------------------

let _warnedMissingSecret = false;

function checkSecret(req: Request, res: Response): boolean {
  const secret = process.env["ATTRIBUTION_WEBHOOK_SECRET"];
  if (!secret) {
    if (!_warnedMissingSecret) {
      console.warn(
        "[attribution] ATTRIBUTION_WEBHOOK_SECRET is not set — " +
          "conversion webhook accepts unauthenticated requests. " +
          "Set this env var in any non-local environment.",
      );
      _warnedMissingSecret = true;
    }
    return true; // open posture (same as AGENT_API_KEY when unset)
  }

  const provided = req.headers["x-attribution-secret"];
  if (typeof provided !== "string") {
    res.status(401).json({ error: "Missing X-Attribution-Secret header" });
    return false;
  }

  try {
    const a = Buffer.from(secret, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: "Invalid secret" });
      return false;
    }
  } catch {
    res.status(401).json({ error: "Invalid secret" });
    return false;
  }

  return true;
}

const router = Router();

// POST /attribution/conversion
router.post("/conversion", async (req: Request, res: Response) => {
  if (!checkSecret(req, res)) return;

  const parsed = conversionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const body = parsed.data;

  const valueCents = resolveValueCents(body);

  // Resolve partnership and commission.
  const partnership = await findPartnershipByReferralCode(body.referralCode);

  if (!partnership) {
    // Unknown code: keep an audit row, respond 202 unattributed (I-8).
    try {
      await createConversion({
        partnershipId: null,
        referralCode: body.referralCode,
        externalId: body.externalId,
        valueCents,
        currency: body.currency ?? "USD",
        commissionCents: 0,
        customerEmail: body.customerEmail ?? null,
        metadata: body.metadata ? (body.metadata as import("../db/schema.js").JsonValue) : null,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Duplicate unknown-code conversion — still a no-op.
    }
    res.status(202).json({ attributed: false });
    return;
  }

  const commissionCents = computeCommissionCents(valueCents, partnership.commissionRate);

  // Create conversion; handle duplicate externalId idempotently (I-3).
  let conversionId: string;
  try {
    const row = await createConversion({
      partnershipId: partnership.id,
      referralCode: body.referralCode,
      externalId: body.externalId,
      valueCents,
      currency: body.currency ?? "USD",
      commissionCents,
      customerEmail: body.customerEmail ?? null,
      metadata: body.metadata ? (body.metadata as import("../db/schema.js").JsonValue) : null,
    });
    conversionId = row.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(200).json({ duplicate: true });
      return;
    }
    throw err;
  }

  // Append CONVERSION_RECORDED event on the partnership's instance (I-7).
  // Best-effort: an event failure must not reject the webhook (I-8).
  try {
    await appendEvent({
      instanceId: partnership.instanceId,
      type: "CONVERSION_RECORDED",
      payload: { externalId: body.externalId, valueCents, commissionCents, conversionId },
    });
  } catch (err) {
    console.error(
      `[attribution] CONVERSION_RECORDED event failed for instanceId=${partnership.instanceId}:`,
      err,
    );
  }

  res.status(201).json({ attributed: true, conversionId });
});

// POST /attribution/conversion/:externalId/refund
router.post("/conversion/:externalId/refund", async (req: Request, res: Response) => {
  if (!checkSecret(req, res)) return;

  const { externalId } = req.params as { externalId: string };

  const conversion = await findConversionByExternalId(externalId);
  if (!conversion) {
    res.status(404).json({ error: "Conversion not found" });
    return;
  }

  // Already refunded — idempotent no-op.
  if (conversion.refunded) {
    res.status(200).json({ refunded: true, noOp: true });
    return;
  }

  // Locked into a payout — human problem, not an auto-clawback (I-4, PLAN non-goal).
  if (conversion.payoutId) {
    res.status(409).json({ error: "locked into payout", payoutId: conversion.payoutId });
    return;
  }

  await markConversionRefunded(conversion.id);

  // Append CONVERSION_REFUNDED event (I-7), best-effort (I-8).
  if (conversion.partnershipId) {
    const partnership = await findPartnershipByReferralCode(
      conversion.referralCode ?? "",
    ).catch(() => null);
    const instanceId = partnership?.instanceId;
    if (instanceId) {
      try {
        await appendEvent({
          instanceId,
          type: "CONVERSION_REFUNDED",
          payload: { externalId, conversionId: conversion.id },
        });
      } catch (err) {
        console.error(
          `[attribution] CONVERSION_REFUNDED event failed for instanceId=${instanceId}:`,
          err,
        );
      }
    }
  }

  res.status(200).json({ refunded: true });
});

export default router;
