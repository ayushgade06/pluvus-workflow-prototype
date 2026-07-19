import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  campaigns,
  creators,
  executionInstances,
  paymentInfo,
  workflows,
  workflowVersions,
  type InputJsonValue,
  type JsonValue,
  type PaymentInfo,
  type PayoutMethod,
} from "./schema.js";

// ---------------------------------------------------------------------------
// PaymentInfo — payout details collected by the Payment Info node.
// ---------------------------------------------------------------------------
// One row per ExecutionInstance. Created (in PAYMENT_PENDING) when the node
// sends the payout-form link; finalized (PAYMENT_RECEIVED) when the creator
// submits the hosted form. BUG-S1: the `token` column stores ONLY the sha256
// HASH of the bearer token — the raw token lives solely in the email link (and
// the persisted PAYMENT_INFO_SENT event, for idempotent reuse). The link
// resolves back to the instance (creator / campaign / node execution) with no
// authentication (prototype scope), but a DB dump can no longer forge a link.
// Token minting + hashing + TTL live in engine/executors/paymentToken.ts,
// mirroring the sibling payout-confirm token.

/**
 * Create the PaymentInfo row for an instance in the pending state.
 *
 * Idempotent for the node's purposes: the row is keyed by the unique
 * `instanceId`, so a re-run of the Payment Info step (e.g. a BullMQ retry) that
 * tries to create a second row hits the unique constraint. Callers that need to
 * tolerate that should catch the unique violation (see the executor, which
 * reuses the existing link rather than minting a new one).
 *
 * BUG-S1: the caller mints the token (raw + hash + expiry) and passes ONLY the
 * hash + expiry here — the raw token never reaches the DB layer.
 */
export async function createPaymentInfo(data: {
  instanceId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<PaymentInfo> {
  const rows = await db
    .insert(paymentInfo)
    .values({
      instanceId: data.instanceId,
      token: data.tokenHash,
      status: "PAYMENT_PENDING",
      // MED-S5: stamp the token lifecycle at mint time.
      expiresAt: data.expiresAt,
    })
    .returning();
  return rows[0]!;
}

/** The nested instance context Prisma's include used to hang off the row. */
export type PaymentInfoWithInstance = PaymentInfo & {
  instance: {
    id: string;
    currentState: string;
    creator: { name: string; email: string };
    workflowVersion: {
      nodeGraph: JsonValue;
      workflow: { campaign: { brand: string } | null };
    };
  };
};

/** Resolve a payout token back to its PaymentInfo row (with the instance +
 *  creator, so the hosted page can greet the creator by name). The workflow
 *  version's `nodeGraph` is included so the route can read the (stamped)
 *  `shipsPhysicalProduct` flag off the PAYMENT_INFO node and decide whether to
 *  render the shipping-address section. Null when the token is unknown. */
export async function findPaymentInfoByToken(
  rawToken: string,
): Promise<PaymentInfoWithInstance | null> {
  // BUG-S1: the column stores sha256(token). Hash the presented raw token from
  // the URL and look it up by hash equality (the token_key unique index backs
  // this). A DB dump reveals only hashes, so a leaked dump cannot forge a link.
  // Hashed inline (node:crypto) rather than importing the engine helper so the DB
  // layer takes no dependency on engine/ — the hash recipe is identical
  // (sha256 hex) to engine/executors/paymentToken.ts:hashPaymentToken.
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const rows = await db
    .select({
      row: paymentInfo,
      instanceId: executionInstances.id,
      currentState: executionInstances.currentState,
      creatorName: creators.name,
      creatorEmail: creators.email,
      nodeGraph: workflowVersions.nodeGraph,
      brand: campaigns.brand,
    })
    .from(paymentInfo)
    .innerJoin(executionInstances, eq(paymentInfo.instanceId, executionInstances.id))
    .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
    .innerJoin(
      workflowVersions,
      eq(executionInstances.workflowVersionId, workflowVersions.id),
    )
    .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
    .leftJoin(campaigns, eq(workflows.campaignId, campaigns.id))
    .where(eq(paymentInfo.token, tokenHash))
    .limit(1);

  const r = rows[0];
  if (!r) return null;
  return {
    ...r.row,
    instance: {
      id: r.instanceId,
      currentState: r.currentState,
      creator: { name: r.creatorName, email: r.creatorEmail },
      workflowVersion: {
        nodeGraph: r.nodeGraph,
        workflow: { campaign: r.brand === null ? null : { brand: r.brand } },
      },
    },
  };
}

/**
 * Rotate the stored token hash + expiry for an instance's PaymentInfo row.
 *
 * BUG-S1: used only on the rare recovery path (a crash between row-create and
 * event-commit left no raw token recoverable) so the link the caller sends now
 * matches what is stored. A no-op (returns null) if the row is absent. Scoped to
 * PAYMENT_PENDING so a rotation can never touch an already-submitted row.
 */
export async function updatePaymentTokenHash(
  instanceId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<PaymentInfo | null> {
  const rows = await db
    .update(paymentInfo)
    .set({ token: tokenHash, expiresAt })
    .where(
      and(
        eq(paymentInfo.instanceId, instanceId),
        eq(paymentInfo.status, "PAYMENT_PENDING"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** The PaymentInfo row for an instance, if one exists. */
export async function findPaymentInfoByInstance(
  instanceId: string,
): Promise<PaymentInfo | null> {
  const rows = await db
    .select()
    .from(paymentInfo)
    .where(eq(paymentInfo.instanceId, instanceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record a submitted payout form and flip the row to PAYMENT_RECEIVED.
 *
 * Stores the known fields as first-class columns; anything extra the form (or a
 * future field) sends is preserved under `extra` so new payout fields can be
 * added without a schema change (tax id, routing number, invoice ref, …).
 */
export async function markPaymentReceived(
  instanceId: string,
  data: {
    method: PayoutMethod;
    accountIdentifier: string;
    country?: string | null;
    notes?: string | null;
    extra?: InputJsonValue;
  },
): Promise<PaymentInfo> {
  const rows = await db
    .update(paymentInfo)
    .set({
      status: "PAYMENT_RECEIVED",
      method: data.method,
      accountIdentifier: data.accountIdentifier,
      country: data.country ?? null,
      notes: data.notes ?? null,
      ...(data.extra !== undefined ? { extra: data.extra } : {}),
      submittedAt: new Date(),
    })
    .where(eq(paymentInfo.instanceId, instanceId))
    .returning();
  const updated = rows[0];
  if (!updated) {
    // Prisma threw P2025 here; the Payment Info node created the row earlier.
    throw new Error(`PaymentInfo for instance ${instanceId} not found`);
  }
  return updated;
}
