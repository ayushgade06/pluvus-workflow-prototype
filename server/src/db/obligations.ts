import { and, eq, isNull } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { obligations, type Obligation } from "./schema.js";

// ---------------------------------------------------------------------------
// Obligation — the fixed collaboration fee owed to a creator (Phase 3).
// ---------------------------------------------------------------------------
// Minted at partnership activation when a fixed fee was agreed (resolvePartnership).
// A partnership has at most one auto-minted fee obligation; it is payable exactly
// once (status guard PENDING → PAID inside the fixed-fee payout transaction, I-4).
// Money is integer cents (I-1); amountCents is copied from the agreed fee at mint
// (I-2) and never re-derived. Every function takes an optional `client` (default:
// the shared Neon `db`) so the module is hermetically testable on PGlite.

export async function createObligation(
  data: {
    partnershipId: string;
    description: string;
    amountCents: number;
  },
  client: Db | DbTx = db,
): Promise<Obligation> {
  const rows = await client
    .insert(obligations)
    .values({
      partnershipId: data.partnershipId,
      description: data.description,
      amountCents: data.amountCents,
      status: "PENDING",
    })
    .returning();
  return rows[0]!;
}

export async function findObligationById(
  id: string,
  client: Db = db,
): Promise<Obligation | null> {
  const rows = await client
    .select()
    .from(obligations)
    .where(eq(obligations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listObligationsByPartnership(
  partnershipId: string,
  client: Db = db,
): Promise<Obligation[]> {
  return client
    .select()
    .from(obligations)
    .where(eq(obligations.partnershipId, partnershipId))
    .orderBy(obligations.createdAt);
}

/** Pending (unpaid, uncancelled) obligations for a partnership. */
export async function listPendingObligations(
  partnershipId: string,
  client: Db = db,
): Promise<Obligation[]> {
  return client
    .select()
    .from(obligations)
    .where(
      and(
        eq(obligations.partnershipId, partnershipId),
        eq(obligations.status, "PENDING"),
        isNull(obligations.payoutId),
      ),
    );
}
