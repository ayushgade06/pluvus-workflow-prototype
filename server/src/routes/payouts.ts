import { Router } from "express";
import type { Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  campaigns,
  creators,
  obligations,
  partnerships,
  paymentInfo,
} from "../db/schema.js";
import {
  appendEvent,
  createCommissionPayout,
  createFixedFeePayout,
  findObligationById,
  findPayoutById,
  findCreatorById,
  findInstanceById,
  listObligationsByPartnership,
  listPayoutsByPartnership,
  loadPayoutContextByPartnership,
  markPayoutSent,
  markPayoutSettled,
  updatePayoutConfirmToken,
  NoUnpaidCommissionError,
  ObligationNotPayableError,
  type PayoutContext,
  type PayoutDestination,
} from "../db/index.js";
import type { JsonObject } from "../db/schema.js";
import { emailProvider } from "../engine/providerFactory.js";
import { sendOnce } from "../engine/executors/idempotentSend.js";
import {
  mintPayoutToken,
  payoutConfirmLink,
  payoutConfirmTtlDays,
  payoutDisputeLink,
} from "../engine/executors/payoutToken.js";
import { renderPayoutSentEmail } from "../engine/executors/payoutSentEmail.js";

// ---------------------------------------------------------------------------
// Brand-side payout routes (Phase 3) — unauthenticated (repo convention; the
// creator-facing mutations are magic-link-gated instead). Mounted at /payouts.
//
//   POST /payouts/partnerships/:partnershipId/commission  — batch unpaid conversions
//   POST /payouts/obligations/:obligationId/fixed-fee     — pay a fixed-fee obligation
//   POST /payouts/:id/send                                — mark paid + email the creator
//   POST /payouts/:id/resend                              — re-mint token + re-email (SENT only)
//   POST /payouts/:id/settle                              — resolve (CONFIRMED|DISPUTED → SETTLED)
//   GET  /payouts/partnerships/:partnershipId             — list a partnership's payouts + obligations
// ---------------------------------------------------------------------------

const router = Router();

/** The payout destination copied from PaymentInfo at creation (I-2). */
function destinationOf(ctx: PayoutContext): PayoutDestination {
  return { method: ctx.paymentMethod, destination: ctx.paymentAccountIdentifier };
}

// ── POST /payouts/partnerships/:partnershipId/commission ───────────────────
router.post(
  "/partnerships/:partnershipId/commission",
  async (req: Request, res: Response) => {
    const { partnershipId } = req.params as { partnershipId: string };

    const ctx = await loadPayoutContextByPartnership(partnershipId);
    if (!ctx) {
      res.status(404).json({ error: "Partnership not found" });
      return;
    }
    // I-2 guard: the payout copies method/destination from PaymentInfo. A
    // Phase-1-minted partnership always has one, but guard anyway.
    if (!ctx.paymentAccountIdentifier) {
      res.status(409).json({ error: "creator has no payout info" });
      return;
    }

    let payout;
    try {
      payout = await createCommissionPayout(partnershipId, destinationOf(ctx));
    } catch (err) {
      if (err instanceof NoUnpaidCommissionError) {
        res.status(400).json({ error: "no unpaid commission" });
        return;
      }
      throw err;
    }

    await appendPayoutEvent(ctx.instanceId, "PAYOUT_CREATED", {
      payoutId: payout.id,
      payoutType: payout.payoutType,
      amountCents: payout.amountCents,
      conversionCount: payout.conversionCount,
    });

    res.status(201).json(payout);
  },
);

// ── POST /payouts/obligations/:obligationId/fixed-fee ──────────────────────
router.post(
  "/obligations/:obligationId/fixed-fee",
  async (req: Request, res: Response) => {
    const { obligationId } = req.params as { obligationId: string };

    const obligation = await findObligationById(obligationId);
    if (!obligation) {
      res.status(404).json({ error: "Obligation not found" });
      return;
    }

    const ctx = await loadPayoutContextByPartnership(obligation.partnershipId);
    if (!ctx) {
      res.status(404).json({ error: "Partnership not found" });
      return;
    }
    if (!ctx.paymentAccountIdentifier) {
      res.status(409).json({ error: "creator has no payout info" });
      return;
    }

    let payout;
    try {
      payout = await createFixedFeePayout(obligationId, destinationOf(ctx));
    } catch (err) {
      if (err instanceof ObligationNotPayableError) {
        // Parent's guard-message shape (payouts.ts:179-181): current status.
        res.status(400).json({
          error: `Obligation must be pending before payout. Current status: '${err.currentStatus}'`,
        });
        return;
      }
      throw err;
    }

    await appendPayoutEvent(ctx.instanceId, "PAYOUT_CREATED", {
      payoutId: payout.id,
      payoutType: payout.payoutType,
      amountCents: payout.amountCents,
      obligationId,
    });

    res.status(201).json(payout);
  },
);

// ── POST /payouts/:id/send ─────────────────────────────────────────────────
router.post("/:id/send", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { reference?: unknown; note?: unknown };
  const reference = typeof body.reference === "string" ? body.reference.trim() || null : null;
  const note = typeof body.note === "string" ? body.note.trim() || null : null;

  const payout = await findPayoutById(id);
  if (!payout) {
    res.status(404).json({ error: "Payout not found" });
    return;
  }
  if (payout.status !== "PENDING") {
    res.status(400).json({
      error: `Only pending payouts can be marked sent. Current status: ${payout.status}`,
    });
    return;
  }

  // Mint the confirm token (raw only in the email; store the hash + expiry).
  const token = mintPayoutToken();

  // Guard against a lost race: markPayoutSent's WHERE requires status PENDING,
  // so a concurrent send returns null → this one is a no-op 409.
  const updated = await markPayoutSent(id, {
    confirmTokenHash: token.tokenHash,
    confirmTokenExpiresAt: token.expiresAt,
    reference,
    note,
  });
  if (!updated) {
    res.status(409).json({ error: "Payout is no longer pending" });
    return;
  }

  // Load the payout context ONCE and reuse it for both the event attribution and
  // the email (avoids a second identical 4-table join, and keeps the event's
  // instanceId and the email's brand/creator reading the same snapshot).
  const ctx = await loadPayoutContextByPartnership(updated.partnershipId);

  await appendPayoutEvent(ctx?.instanceId ?? null, "PAYOUT_SENT", {
    payoutId: updated.id,
    amountCents: updated.amountCents,
    reference,
  });

  // Email the creator (idempotent, I-6). Email failure does NOT roll back the
  // SENT status (parent posture) — the response carries emailSent:false and the
  // brand can POST /resend.
  const emailSent = await sendPayoutSentEmail(ctx, updated, token.rawToken, {
    key: `payout:sent:${updated.id}`,
  });

  res.json({ ...updated, emailSent });
});

// ── POST /payouts/:id/resend ───────────────────────────────────────────────
// Re-mint the token + re-email from SENT (e.g. the first send's email failed).
// Only from SENT — a settled/disputed payout is not resent.
router.post("/:id/resend", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const payout = await findPayoutById(id);
  if (!payout) {
    res.status(404).json({ error: "Payout not found" });
    return;
  }
  if (payout.status !== "SENT") {
    res.status(400).json({
      error: `Only sent payouts can be resent. Current status: ${payout.status}`,
    });
    return;
  }

  // Re-mint a fresh token (invalidates the previous link — the new hash replaces
  // the old). markPayoutSent's WHERE requires PENDING, so re-mint directly here.
  const token = mintPayoutToken();
  const updated = await updatePayoutConfirmToken(id, {
    confirmTokenHash: token.tokenHash,
    confirmTokenExpiresAt: token.expiresAt,
  });
  if (!updated) {
    res.status(409).json({ error: "Payout is no longer sent" });
    return;
  }

  // Resend uses a per-attempt key so sendOnce actually re-sends (a fresh row).
  // The suffix is derived from the freshly-minted token hash — server-controlled
  // and unique per resend — NOT from a client query param (a non-numeric ?n
  // would coerce to NaN and silently collapse every resend onto one key, turning
  // the resend into a no-op that still reports emailSent).
  const ctx = await loadPayoutContextByPartnership(updated.partnershipId);
  const emailSent = await sendPayoutSentEmail(ctx, updated, token.rawToken, {
    key: `payout:resent:${updated.id}:${token.tokenHash.slice(0, 16)}`,
  });

  res.json({ ...updated, emailSent });
});

// ── POST /payouts/:id/settle ───────────────────────────────────────────────
router.post("/:id/settle", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const payout = await findPayoutById(id);
  if (!payout) {
    res.status(404).json({ error: "Payout not found" });
    return;
  }
  if (payout.status !== "CONFIRMED" && payout.status !== "DISPUTED") {
    res.status(400).json({
      error: `Only confirmed or disputed payouts can be settled. Current status: ${payout.status}`,
    });
    return;
  }

  const settled = await markPayoutSettled(id);
  if (!settled) {
    res.status(409).json({ error: "Payout could not be settled" });
    return;
  }

  await appendPayoutEvent(
    await instanceIdForPayout(settled.partnershipId),
    "PAYOUT_SETTLED",
    { payoutId: settled.id, resolvedBy: "brand" },
  );

  res.json(settled);
});

// ── GET /payouts/partnerships/:partnershipId ───────────────────────────────
// Read-only: a partnership's payouts + obligations (dashboard support, Phase 4).
router.get(
  "/partnerships/:partnershipId",
  async (req: Request, res: Response) => {
    const { partnershipId } = req.params as { partnershipId: string };
    // 404 an unknown partnership so the dashboard can tell "no payouts yet" from
    // "wrong/deleted partnership" (an empty 200 masks a broken link).
    const ctx = await loadPayoutContextByPartnership(partnershipId);
    if (!ctx) {
      res.status(404).json({ error: "Partnership not found" });
      return;
    }
    const [partnershipPayouts, partnershipObligations] = await Promise.all([
      listPayoutsByPartnership(partnershipId),
      listObligationsByPartnership(partnershipId),
    ]);
    res.json({ payouts: partnershipPayouts, obligations: partnershipObligations });
  },
);

// ── GET /payouts/export/paypal-csv ────────────────────────────────────────────
// PayPal bulk-payment CSV: one row per partnership that has unpaid amounts and a
// destination (PayPal email). Ported from parent Pluvus/server/routes/api/payouts.ts:257-303.
// Amounts rendered as dollars with 2 decimals (from cents). Same CSV-escape helper.
// NOTE: this is informational — creating/locking payouts still goes through the
// transactional per-creator endpoints (Phase 3). The CSV is what the brand pastes
// into PayPal's batch payment tool.
router.get("/export/paypal-csv", async (_req: Request, res: Response) => {
  // One query: partnerships with creator + campaign + PaymentInfo (for paypal email)
  // + obligation rollup + unpaid commission rollup. Filter: unpaid > 0 AND has destination.
  const rows = await db
    .select({
      partnershipId: partnerships.id,
      creatorName: creators.name,
      creatorEmail: creators.email,
      campaignName: campaigns.name,
      paypalEmail: paymentInfo.accountIdentifier,
      agreedFeeCents: partnerships.agreedFeeCents,
    })
    .from(partnerships)
    .innerJoin(creators, eq(partnerships.creatorId, creators.id))
    .leftJoin(campaigns, eq(partnerships.campaignId, campaigns.id))
    .leftJoin(paymentInfo, eq(paymentInfo.instanceId, partnerships.instanceId))
    .where(sql`${paymentInfo.method} = 'PAYPAL' AND ${paymentInfo.accountIdentifier} IS NOT NULL`);

  if (rows.length === 0) {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=paypal-payouts-${isoDate()}.csv`);
    res.send("creator_name,creator_email,paypal_email,amount,currency,note,partnership_id\n");
    return;
  }

  const ids = rows.map((r) => r.partnershipId);

  // Unpaid obligation sum per partnership.
  const obRows = await db
    .select({
      partnershipId: obligations.partnershipId,
      unpaidFeeCents: sql<number>`coalesce(sum(${obligations.amountCents}) filter (where ${obligations.status} = 'PENDING' and ${obligations.payoutId} is null), 0)`,
    })
    .from(obligations)
    .where(
      sql`${obligations.partnershipId} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    .groupBy(obligations.partnershipId);

  const obMap = new Map(obRows.map((r) => [r.partnershipId, Number(r.unpaidFeeCents)]));

  // Unpaid commission sum per partnership.
  const convRows = await db.execute<{ partnershipId: string; unpaidCommissionCents: string }>(sql`
    SELECT "partnershipId",
           coalesce(sum("commissionCents") filter (where "payoutId" is null and "refunded" = false and "commissionCents" > 0), 0) as "unpaidCommissionCents"
    FROM "Conversion"
    WHERE "partnershipId" IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    GROUP BY "partnershipId"
  `);
  const commMap = new Map(
    convRows.rows.map((r) => [r.partnershipId, Number(r.unpaidCommissionCents)]),
  );

  // Build CSV rows — only include partnerships with unpaid amounts.
  const header = "creator_name,creator_email,paypal_email,amount,currency,note,partnership_id";
  const csvRows: string[] = [header];

  for (const row of rows) {
    const unpaidFee = obMap.get(row.partnershipId) ?? 0;
    const unpaidComm = commMap.get(row.partnershipId) ?? 0;
    const totalCents = unpaidFee + unpaidComm;
    if (totalCents <= 0) continue;

    const amount = (totalCents / 100).toFixed(2);
    const note = buildPaypalNote(unpaidFee, unpaidComm, row.campaignName);

    csvRows.push(
      [
        csvEsc(row.creatorName),
        csvEsc(row.creatorEmail),
        csvEsc(row.paypalEmail ?? ""),
        amount,
        "USD",
        csvEsc(note),
        csvEsc(row.partnershipId),
      ].join(","),
    );
  }

  const today = isoDate();
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=paypal-payouts-${today}.csv`);
  res.send(csvRows.join("\n") + "\n");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append a ledger event to the payout's instance (I-7), best-effort (I-8). */
async function appendPayoutEvent(
  instanceId: string | null,
  type:
    | "PAYOUT_CREATED"
    | "PAYOUT_SENT"
    | "PAYOUT_SETTLED",
  payload: JsonObject,
): Promise<void> {
  if (!instanceId) return;
  try {
    await appendEvent({ instanceId, type, payload });
  } catch (err) {
    console.error(`[payouts] ${type} event append failed (non-fatal)`, err);
  }
}

/** Resolve the instanceId a partnership belongs to (for event attribution). */
async function instanceIdForPayout(partnershipId: string): Promise<string | null> {
  const ctx = await loadPayoutContextByPartnership(partnershipId);
  return ctx?.instanceId ?? null;
}

/**
 * Send the "you've been paid" email to the creator (idempotent). Returns whether
 * the send succeeded — a failure is logged, never thrown (the payout is already
 * SENT; the brand can resend). Takes the already-loaded PayoutContext so the
 * caller's single context load is reused. The creator row is loaded so sendOnce
 * can address the thread owner (the provider reads its email/name).
 */
async function sendPayoutSentEmail(
  ctx: PayoutContext | null,
  payout: { id: string; amountCents: number; currency: string; reference: string | null },
  rawToken: string,
  opts: { key: string },
): Promise<boolean> {
  try {
    if (!ctx) return false;
    const creator = await creatorForInstance(ctx.instanceId);
    if (!creator) return false;

    const draft = renderPayoutSentEmail({
      creatorName: ctx.creatorName,
      brandName: ctx.brandName ?? "Your brand",
      amountCents: payout.amountCents,
      currency: payout.currency,
      reference: payout.reference,
      confirmLink: payoutConfirmLink(payout.id, rawToken),
      disputeLink: payoutDisputeLink(payout.id, rawToken),
      ttlDays: payoutConfirmTtlDays(),
    });

    await sendOnce(emailProvider(), ctx.instanceId, creator, draft, opts.key);
    return true;
  } catch (err) {
    console.error("[payouts] payout-sent email failed (non-fatal)", err);
    return false;
  }
}

/** Load the Creator behind an instance (sendOnce addresses the thread owner). */
async function creatorForInstance(instanceId: string) {
  const inst = await findInstanceById(instanceId);
  if (!inst) return null;
  return findCreatorById(inst.creatorId);
}

// ---------------------------------------------------------------------------
// CSV helpers (ported from parent Pluvus/server/routes/api/payouts.ts:257-303)
// ---------------------------------------------------------------------------

/**
 * RFC 4180 CSV field escape: wrap in quotes and double any internal quotes.
 * e.g. `O'Brien, "Bob"` → `"O'Brien, ""Bob"""`
 */
export function csvEsc(value: string): string {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildPaypalNote(feeCents: number, commCents: number, campaignName: string | null): string {
  const parts: string[] = [];
  if (feeCents > 0) parts.push(`Fee: $${(feeCents / 100).toFixed(2)}`);
  if (commCents > 0) parts.push(`Commission: $${(commCents / 100).toFixed(2)}`);
  if (campaignName) parts.push(`Campaign: ${campaignName}`);
  return parts.join(" | ");
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export default router;
