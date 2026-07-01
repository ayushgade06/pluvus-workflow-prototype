import type { PaymentInfo, PayoutMethod, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "./client.js";

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

/**
 * Create the PaymentInfo row for an instance in the pending state.
 *
 * Idempotent for the node's purposes: the row is keyed by the unique
 * `instanceId`, so a re-run of the Payment Info step (e.g. a BullMQ retry) that
 * tries to create a second row hits the unique constraint. Callers that need to
 * tolerate that should catch P2002 (see the executor, which reuses the existing
 * row's token rather than minting a new link).
 */
export async function createPaymentInfo(data: {
  instanceId: string;
  token: string;
}): Promise<PaymentInfo> {
  return prisma.paymentInfo.create({
    data: {
      token: data.token,
      status: "PAYMENT_PENDING",
      instance: { connect: { id: data.instanceId } },
    },
  });
}

/** Resolve a payout token back to its PaymentInfo row (with the instance +
 *  creator, so the hosted page can greet the creator by name). Null when the
 *  token is unknown. */
export async function findPaymentInfoByToken(
  token: string,
): Promise<
  | (PaymentInfo & {
      instance: {
        id: string;
        currentState: string;
        creator: { name: string; email: string };
        workflowVersion: { workflow: { campaign: { brand: string } | null } };
      };
    })
  | null
> {
  return prisma.paymentInfo.findUnique({
    where: { token },
    include: {
      instance: {
        select: {
          id: true,
          currentState: true,
          creator: { select: { name: true, email: true } },
          workflowVersion: {
            select: { workflow: { select: { campaign: { select: { brand: true } } } } },
          },
        },
      },
    },
  }) as never;
}

/** The PaymentInfo row for an instance, if one exists. */
export async function findPaymentInfoByInstance(
  instanceId: string,
): Promise<PaymentInfo | null> {
  return prisma.paymentInfo.findUnique({ where: { instanceId } });
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
    extra?: Prisma.InputJsonValue;
  },
): Promise<PaymentInfo> {
  return prisma.paymentInfo.update({
    where: { instanceId },
    data: {
      status: "PAYMENT_RECEIVED",
      method: data.method,
      accountIdentifier: data.accountIdentifier,
      country: data.country ?? null,
      notes: data.notes ?? null,
      ...(data.extra !== undefined ? { extra: data.extra } : {}),
      submittedAt: new Date(),
    },
  });
}
