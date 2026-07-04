import { listExpiredPendingBrandDecisions } from "../db/brandDecision.js";
import { WorkflowRuntime } from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import { logTrace } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Brand-decision silence-timeout sweep (MANUAL_ESCALATION_RESOLUTION.md §2.6)
// ---------------------------------------------------------------------------
// Runs on the scheduler poll cadence (reusing the existing scheduler seam). Any
// BrandDecision still PENDING past its expiresAt (default 72h) is swept: the
// instance moves AWAITING_BRAND_DECISION → MANUAL_REVIEW and the operator is
// pinged, so a brand that never replies never strands a creator forever
// (locked decision 3).
//
// Idempotent: expireBrandDecision does an OCC transition, so overlapping sweeps
// (or a late brand reply racing the sweep) resolve to a single expiry; extra
// attempts no-op. Best-effort per row — one failure never aborts the batch.

export async function sweepExpiredBrandDecisions(now: Date = new Date()): Promise<number> {
  let expired;
  try {
    expired = await listExpiredPendingBrandDecisions(now);
  } catch (err) {
    console.error(
      "[scheduler/brand-decision-sweep] DB query failed:",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }

  if (expired.length === 0) return 0;

  console.log(
    `[scheduler/brand-decision-sweep] ${expired.length} expired brand decision(s) found`,
  );

  // Construct once per sweep. NODE_ENV governs mock-vs-real providers exactly as
  // every other scheduler-triggered path; the operator ping goes through the
  // email provider inside expireBrandDecision.
  const runtime = new WorkflowRuntime(emailProvider(), agentProvider());

  let sweptCount = 0;
  const results = await Promise.allSettled(
    expired.map(async (decision) => {
      const didExpire = await runtime.expireBrandDecision(decision.instanceId, decision.id);
      if (didExpire) {
        sweptCount++;
        console.log(
          `[scheduler/brand-decision-sweep] expired ${decision.id} → ${decision.instanceId} moved to MANUAL_REVIEW`,
        );
        logTrace("brand_decision_expired", {
          source: "scheduler",
          instanceId: decision.instanceId,
          brandDecisionId: decision.id,
          reason: decision.reason,
          expiresAt: decision.expiresAt.toISOString(),
        });
      }
    }),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      console.error(
        "[scheduler/brand-decision-sweep] expiry failed:",
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
  }

  return sweptCount;
}
