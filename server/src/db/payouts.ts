import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  conversions,
  obligations,
  partnerships,
  payouts,
  type Payout,
  type PayoutMethod,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Payout — a concrete disbursement the brand records as paid (Phase 3).
// ---------------------------------------------------------------------------
// Two kinds: a COMMISSION batch (sums the partnership's unpaid conversions and
// locks each into this one payout) and a FIXED_FEE (pays a single obligation).
// Both creators run in a single DB transaction with a `SELECT … FOR UPDATE` on
// the rows they consume, so two concurrent create calls can never double-pay the
// same money (I-4). Money is integer cents (I-1); method/destination are copied
// from PaymentInfo at creation (I-2).
//
// Every function takes an optional `client` (default: the shared Neon `db`) so
// the whole module is hermetically testable against an embedded PGlite DB — the
// same injectable-client seam updateInstanceStateConditional / appendEvent use.

// The subset of PaymentInfo the payout copies at creation (I-2). Missing/blank
// account identifier is a caller-level 409 (guarded in the route).
export interface PayoutDestination {
  method: PayoutMethod | null;
  destination: string | null;
}

export class NoUnpaidCommissionError extends Error {
  constructor() {
    super("no unpaid commission");
    this.name = "NoUnpaidCommissionError";
  }
}

export class ObligationNotPayableError extends Error {
  readonly currentStatus: string;
  constructor(currentStatus: string) {
    super(`obligation is not payable (status: ${currentStatus})`);
    this.name = "ObligationNotPayableError";
    this.currentStatus = currentStatus;
  }
}

// ---------------------------------------------------------------------------
// createCommissionPayout — lock unpaid conversions and pay them as one batch.
// ---------------------------------------------------------------------------
// I-4: the `SELECT … FOR UPDATE` inside the transaction is what makes concurrent
// double-create safe. Two parallel callers contend on the same conversion rows;
// the first to lock them wins, inserts the payout, and stamps payoutId; the
// second, once it acquires the lock, re-reads and finds zero rows still unpaid
// (payoutId IS NULL no longer matches) and rolls back with NoUnpaidCommission.
export async function createCommissionPayout(
  partnershipId: string,
  dest: PayoutDestination,
  client: Db | DbTx = db,
): Promise<Payout> {
  return client.transaction(async (tx) => {
    // Lock every unpaid, non-refunded, commission-bearing conversion for this
    // partnership. FOR UPDATE via a raw sql fragment (version-independent).
    const locked = await tx.execute<{ id: string; commissionCents: number }>(sql`
      SELECT "id", "commissionCents"
      FROM "Conversion"
      WHERE "partnershipId" = ${partnershipId}
        AND "payoutId" IS NULL
        AND "refunded" = false
        AND "commissionCents" > 0
      FOR UPDATE
    `);

    const rows = locked.rows;
    if (rows.length === 0) {
      // Nothing to pay — abort the transaction (releases the lock, no payout).
      throw new NoUnpaidCommissionError();
    }

    const amountCents = rows.reduce(
      (sum, r) => sum + Number(r.commissionCents),
      0,
    );
    const conversionIds = rows.map((r) => r.id);

    const inserted = await tx
      .insert(payouts)
      .values({
        partnershipId,
        payoutType: "COMMISSION",
        amountCents,
        status: "PENDING",
        method: dest.method,
        destination: dest.destination,
        conversionCount: rows.length,
      })
      .returning();
    const payout = inserted[0]!;

    // Lock each conversion into this payout (I-4). The FOR UPDATE lock above
    // guarantees no other transaction can have grabbed these rows in between.
    await tx
      .update(conversions)
      .set({ payoutId: payout.id })
      .where(
        sql`${conversions.id} IN (${sql.join(
          conversionIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    return payout;
  });
}

// ---------------------------------------------------------------------------
// createFixedFeePayout — pay a single obligation, guarding its status in-txn.
// ---------------------------------------------------------------------------
// I-4: re-read the obligation FOR UPDATE; it must be PENDING (else reject with
// its current status). Insert the FIXED_FEE payout, then flip the obligation to
// PAID + link it — all atomically, so it is payable exactly once.
export async function createFixedFeePayout(
  obligationId: string,
  dest: PayoutDestination,
  client: Db | DbTx = db,
): Promise<Payout> {
  return client.transaction(async (tx) => {
    const locked = await tx.execute<{
      id: string;
      partnershipId: string;
      amountCents: number;
      status: string;
    }>(sql`
      SELECT "id", "partnershipId", "amountCents", "status"
      FROM "Obligation"
      WHERE "id" = ${obligationId}
      FOR UPDATE
    `);

    const ob = locked.rows[0];
    if (!ob) {
      // Caller checked existence first; a race deleted it (won't happen — no
      // deletes). Surface as not-payable with a clear status.
      throw new ObligationNotPayableError("MISSING");
    }
    if (ob.status !== "PENDING") {
      throw new ObligationNotPayableError(ob.status);
    }

    const inserted = await tx
      .insert(payouts)
      .values({
        partnershipId: ob.partnershipId,
        payoutType: "FIXED_FEE",
        amountCents: Number(ob.amountCents),
        status: "PENDING",
        method: dest.method,
        destination: dest.destination,
        conversionCount: 0,
      })
      .returning();
    const payout = inserted[0]!;

    await tx
      .update(obligations)
      .set({ status: "PAID", payoutId: payout.id, paidAt: new Date() })
      .where(eq(obligations.id, obligationId));

    return payout;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findPayoutById(
  id: string,
  client: Db | DbTx = db,
): Promise<Payout | null> {
  const rows = await client.select().from(payouts).where(eq(payouts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listPayoutsByPartnership(
  partnershipId: string,
  client: Db | DbTx = db,
): Promise<Payout[]> {
  return client
    .select()
    .from(payouts)
    .where(eq(payouts.partnershipId, partnershipId))
    .orderBy(desc(payouts.createdAt));
}

/** SENT payouts whose sentAt is older than `cutoff` — the auto-settle sweep source. */
export async function listSentPayoutsOlderThan(
  cutoff: Date,
  client: Db | DbTx = db,
): Promise<Payout[]> {
  return client
    .select()
    .from(payouts)
    .where(and(eq(payouts.status, "SENT"), lt(payouts.sentAt, cutoff)));
}

/** SENT payouts older than `cutoff`, each with its partnership's instanceId — so
 *  the auto-settle sweep can append the PAYOUT_SETTLED event on the right
 *  instance (I-7) without a second round-trip per payout. */
export async function listSentPayoutsOlderThanWithInstance(
  cutoff: Date,
  client: Db | DbTx = db,
): Promise<Array<{ payout: Payout; instanceId: string }>> {
  const rows = await client
    .select({ payout: payouts, instanceId: partnerships.instanceId })
    .from(payouts)
    .innerJoin(partnerships, eq(payouts.partnershipId, partnerships.id))
    .where(and(eq(payouts.status, "SENT"), lt(payouts.sentAt, cutoff)));
  return rows.map((r) => ({ payout: r.payout, instanceId: r.instanceId }));
}

// ---------------------------------------------------------------------------
// Status transitions (each guarded by a WHERE on the expected status so the
// update is a no-op if a concurrent path already moved the row — the returned
// row array is empty on a lost race).
// ---------------------------------------------------------------------------

/** PENDING → SENT: stamp the confirm-token hash, reference, note, sentAt. */
export async function markPayoutSent(
  id: string,
  data: {
    confirmTokenHash: string;
    confirmTokenExpiresAt: Date;
    reference: string | null;
    note: string | null;
  },
  client: Db | DbTx = db,
): Promise<Payout | null> {
  const rows = await client
    .update(payouts)
    .set({
      status: "SENT",
      sentAt: new Date(),
      reference: data.reference,
      note: data.note,
      confirmTokenHash: data.confirmTokenHash,
      confirmTokenExpiresAt: data.confirmTokenExpiresAt,
    })
    .where(and(eq(payouts.id, id), eq(payouts.status, "PENDING")))
    .returning();
  return rows[0] ?? null;
}

/** Re-mint a SENT payout's confirm token (resend path): replace hash + expiry.
 *  Guarded on SENT so a resend can't touch a settled/disputed payout. */
export async function updatePayoutConfirmToken(
  id: string,
  data: { confirmTokenHash: string; confirmTokenExpiresAt: Date },
  client: Db | DbTx = db,
): Promise<Payout | null> {
  const rows = await client
    .update(payouts)
    .set({
      confirmTokenHash: data.confirmTokenHash,
      confirmTokenExpiresAt: data.confirmTokenExpiresAt,
    })
    .where(and(eq(payouts.id, id), eq(payouts.status, "SENT")))
    .returning();
  return rows[0] ?? null;
}

/** SENT → SETTLED (creator confirmed): stamp confirmedAt + settledAt + audit. */
export async function markPayoutConfirmed(
  id: string,
  audit: { confirmIp: string | null; confirmUserAgent: string | null },
  client: Db | DbTx = db,
): Promise<Payout | null> {
  const now = new Date();
  const rows = await client
    .update(payouts)
    .set({
      status: "SETTLED",
      confirmedAt: now,
      settledAt: now,
      confirmIp: audit.confirmIp,
      confirmUserAgent: audit.confirmUserAgent,
    })
    .where(and(eq(payouts.id, id), eq(payouts.status, "SENT")))
    .returning();
  return rows[0] ?? null;
}

/** SENT → DISPUTED (creator disputed): stamp disputedAt + audit. */
export async function markPayoutDisputed(
  id: string,
  audit: { confirmIp: string | null; confirmUserAgent: string | null },
  client: Db | DbTx = db,
): Promise<Payout | null> {
  const rows = await client
    .update(payouts)
    .set({
      status: "DISPUTED",
      disputedAt: new Date(),
      confirmIp: audit.confirmIp,
      confirmUserAgent: audit.confirmUserAgent,
    })
    .where(and(eq(payouts.id, id), eq(payouts.status, "SENT")))
    .returning();
  return rows[0] ?? null;
}

/** CONFIRMED|DISPUTED → SETTLED (brand resolves). */
export async function markPayoutSettled(
  id: string,
  client: Db | DbTx = db,
): Promise<Payout | null> {
  const rows = await client
    .update(payouts)
    .set({ status: "SETTLED", settledAt: new Date() })
    .where(
      and(
        eq(payouts.id, id),
        sql`${payouts.status} IN ('CONFIRMED', 'DISPUTED')`,
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Auto-settle a SENT payout that got no creator response (scheduler sweep). */
export async function autoSettlePayout(
  id: string,
  client: Db | DbTx = db,
): Promise<Payout | null> {
  const rows = await client
    .update(payouts)
    .set({ status: "SETTLED", settledAt: new Date() })
    .where(and(eq(payouts.id, id), eq(payouts.status, "SENT")))
    .returning();
  return rows[0] ?? null;
}
