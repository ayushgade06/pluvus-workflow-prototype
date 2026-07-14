import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
// submits the hosted form. The unique `token` is the capability embedded in the
// link — it resolves back to the instance (and thus creator / campaign / node
// execution) without any authentication (prototype scope).

/** A secure, unguessable token for the hosted payout-form URL. */
export function generatePaymentToken(): string {
  return randomUUID();
}

// MED-S5: how long a payout link stays usable. The token is a bearer
// capability, so a leaked/forwarded link must not work forever. 30 days is
// generous for "fill in your payout details"; tunable via PAYMENT_TOKEN_TTL_DAYS.
const DEFAULT_PAYMENT_TOKEN_TTL_DAYS = 30;

export function paymentTokenExpiry(now: Date = new Date()): Date {
  const raw = Number(process.env["PAYMENT_TOKEN_TTL_DAYS"]);
  const days =
    Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PAYMENT_TOKEN_TTL_DAYS;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Create the PaymentInfo row for an instance in the pending state.
 *
 * Idempotent for the node's purposes: the row is keyed by the unique
 * `instanceId`, so a re-run of the Payment Info step (e.g. a BullMQ retry) that
 * tries to create a second row hits the unique constraint. Callers that need to
 * tolerate that should catch the unique violation (see the executor, which
 * reuses the existing row's token rather than minting a new link).
 */
export async function createPaymentInfo(data: {
  instanceId: string;
  token: string;
}): Promise<PaymentInfo> {
  const rows = await db
    .insert(paymentInfo)
    .values({
      instanceId: data.instanceId,
      token: data.token,
      status: "PAYMENT_PENDING",
      // MED-S5: stamp the token lifecycle at mint time.
      expiresAt: paymentTokenExpiry(),
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
  token: string,
): Promise<PaymentInfoWithInstance | null> {
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
    .where(eq(paymentInfo.token, token))
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
