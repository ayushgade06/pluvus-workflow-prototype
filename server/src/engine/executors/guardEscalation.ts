import type { NodeResult } from "../types.js";
import { maskGuardHits, type GuardHit } from "../guards/outputGuard.js";

// ---------------------------------------------------------------------------
// Shared output-guard escalation (FIX-4)
// ---------------------------------------------------------------------------
// When the output guard blocks an AI-generated draft (a leaked floor/ceiling or
// internal term), the email is NOT sent and the instance routes to MANUAL_REVIEW
// so a human reviews before anything reaches the creator. The negotiation
// executor has an equivalent inline helper; this standalone version lets other
// executors (e.g. Reward Setup) apply the same policy without importing from a
// node module. The offending draft body is deliberately not persisted — only the
// leaked tokens are recorded for audit.
export function blockedByGuard(round: number, hits: GuardHit[]): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "output_guard_blocked",
      round,
      // EASY-S2: mask the band VALUE — record only which KIND leaked.
      leaks: maskGuardHits(hits),
    },
  };
}

// L4: fail loud when a creator-facing email has no resolvable brand name (config
// AND campaign both missing it). Rather than send "Thanks, your brand" to a real
// creator, route the instance to MANUAL_REVIEW so a human fixes the config. This
// only fires on a genuinely mis-stamped / orphaned instance (restampBrand
// normally always sets brandName).
export function blockedByMissingBrand(node: string): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "MANUAL_REVIEW_FLAGGED",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "missing_brand_name",
      node,
    },
  };
}
