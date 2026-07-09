import type { BrandDecision, BrandDecisionStatus, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "./client.js";

// ---------------------------------------------------------------------------
// BrandDecision — a round-trip brand decision that resolves a business
// escalation by email (see MANUAL_ESCALATION_RESOLUTION.md §2.2).
// ---------------------------------------------------------------------------
// One row is created when a *business* escalation parks the run in
// AWAITING_BRAND_DECISION and we email the brand an actionable question. The
// unique `token` is the capability embedded in the reply-to + magic links — it
// resolves an inbound reply / link click back to the instance (and thus creator
// / campaign / node execution) without any authentication (prototype scope),
// exactly like the PaymentInfo token.
//
// Mirrors paymentInfo.ts (token model) for the create/find-by-token/find-by-
// instance helpers and brandNotifications.ts (status model) for the resolution
// update. The token is the reply-matching key; the row is otherwise keyed by
// instanceId for lookups.

/** A secure, unguessable token for the reply-to + magic-link URLs. */
export function generateBrandDecisionToken(): string {
  return randomUUID();
}

/** Default silence timeout: a PENDING decision older than this is swept into
 *  MANUAL_REVIEW by the scheduler (spec §2.6, locked decision 3). */
export const BRAND_DECISION_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

/**
 * Create the BrandDecision row for an instance in the PENDING state.
 *
 * `expiresAt` defaults to BRAND_DECISION_TTL_MS from now when not supplied.
 * The caller is responsible for the `token` (via generateBrandDecisionToken)
 * and the resume `contextJson`. Not keyed by a unique instanceId — an instance
 * can legitimately need more than one brand decision over its lifetime — so
 * idempotency for the *outbound* send is the caller's concern (the executor
 * reuses the latest PENDING row rather than minting a duplicate link).
 */
export async function createBrandDecision(data: {
  instanceId: string;
  reason: string;
  question: string;
  token: string;
  contextJson: Prisma.InputJsonValue;
  expiresAt?: Date;
}): Promise<BrandDecision> {
  return prisma.brandDecision.create({
    data: {
      reason: data.reason,
      question: data.question,
      token: data.token,
      status: "PENDING",
      contextJson: data.contextJson,
      expiresAt: data.expiresAt ?? new Date(Date.now() + BRAND_DECISION_TTL_MS),
      instance: { connect: { id: data.instanceId } },
    },
  });
}

/** Resolve a decision token back to its BrandDecision row (with the instance +
 *  creator, so the magic-link route can greet the brand and re-derive context).
 *  The workflow version's `nodeGraph` is included so the route can read stamped
 *  node config off the graph if needed. Null when the token is unknown. */
export async function findBrandDecisionByToken(
  token: string,
): Promise<
  | (BrandDecision & {
      instance: {
        id: string;
        currentState: string;
        creator: { name: string; email: string };
        workflowVersion: {
          nodeGraph: Prisma.JsonValue;
          workflow: { campaign: { brand: string } | null };
        };
      };
    })
  | null
> {
  return prisma.brandDecision.findUnique({
    where: { token },
    include: {
      instance: {
        select: {
          id: true,
          currentState: true,
          creator: { select: { name: true, email: true } },
          workflowVersion: {
            select: {
              nodeGraph: true,
              workflow: { select: { campaign: { select: { brand: true } } } },
            },
          },
        },
      },
    },
  }) as never;
}

/** The latest PENDING BrandDecision for an instance, if one exists. Used by the
 *  inbound reply branch to route a reply that arrived while the instance is in
 *  AWAITING_BRAND_DECISION (no token on the reply → fall back to the instance). */
export async function findPendingBrandDecisionByInstance(
  instanceId: string,
): Promise<BrandDecision | null> {
  return prisma.brandDecision.findFirst({
    where: { instanceId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * All still-PENDING BrandDecision rows whose silence timeout (expiresAt) has
 * passed. The scheduler sweep moves each into MANUAL_REVIEW + pings the operator
 * so a brand that never replies never strands a creator (spec §2.6 / decision 3).
 * Ordered oldest-first so the longest-waiting creators are handled first.
 */
export async function listExpiredPendingBrandDecisions(
  now: Date = new Date(),
): Promise<BrandDecision[]> {
  return prisma.brandDecision.findMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" },
  });
}

/**
 * The latest PENDING BrandDecision per instance, for a set of instance ids.
 * Returns a Map keyed by instanceId (missing key = no pending decision). Used by
 * the Manual Queue dashboard to show AWAITING_BRAND_DECISION rows with the
 * pending question + timeout. Mirrors listLatestBrandNotificationsForInstances.
 */
export async function listPendingBrandDecisionsForInstances(
  instanceIds: string[],
): Promise<Map<string, BrandDecision>> {
  if (instanceIds.length === 0) return new Map();
  const rows = await prisma.brandDecision.findMany({
    where: { instanceId: { in: instanceIds }, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  const byInstance = new Map<string, BrandDecision>();
  for (const row of rows) {
    // rows are newest-first, so the first seen per instance is the latest.
    if (!byInstance.has(row.instanceId)) byInstance.set(row.instanceId, row);
  }
  return byInstance;
}

/**
 * Idempotently mark a BrandDecision row EXPIRED — ONLY if it is still PENDING
 * (EASY-W2). Returns the number of rows changed (0 if it was already resolved /
 * expired). Used to reconcile an ORPHAN row: the expiry sweep committed the
 * instance transition but the subsequent best-effort status update failed (or a
 * late brand reply moved the instance first), leaving the row PENDING while the
 * instance is no longer AWAITING_BRAND_DECISION — which the sweep would otherwise
 * re-process every poll forever. The status=PENDING guard makes this safe to call
 * unconditionally and race-free against a concurrent resolution.
 */
export async function expirePendingBrandDecision(
  id: string,
  now: Date = new Date(),
): Promise<number> {
  const res = await prisma.brandDecision.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "EXPIRED", decision: "AMBIGUOUS", resolvedAt: now },
  });
  return res.count;
}

/**
 * Record the brand's parsed decision on a BrandDecision row and move it to a
 * new status. Mirrors updateBrandNotificationStatus (status model): only the
 * fields present are written, so an omitted optional isn't overwritten.
 *
 * Used for every resolution outcome:
 *   RESOLVED   — a parseable decision (APPROVE/REJECT/COUNTER); resolvedAt set.
 *   REASKED    — an ambiguous reply; reaskCount incremented by the caller.
 *   HANDED_OFF — brand asked for a human handoff.
 *   EXPIRED    — the 72h sweep (set by the scheduler, not this path).
 */
export async function updateBrandDecision(
  id: string,
  data: {
    status?: BrandDecisionStatus;
    brandReplyRaw?: string | null;
    decision?: string | null;
    decisionValue?: number | null;
    reaskCount?: number;
    resolvedAt?: Date | null;
  },
): Promise<BrandDecision> {
  return prisma.brandDecision.update({
    where: { id },
    data: {
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.brandReplyRaw !== undefined ? { brandReplyRaw: data.brandReplyRaw } : {}),
      ...(data.decision !== undefined ? { decision: data.decision } : {}),
      ...(data.decisionValue !== undefined ? { decisionValue: data.decisionValue } : {}),
      ...(data.reaskCount !== undefined ? { reaskCount: data.reaskCount } : {}),
      ...(data.resolvedAt !== undefined ? { resolvedAt: data.resolvedAt } : {}),
    },
  });
}
