import type { listEventsByInstance } from "../../db/index.js";
import { buildPriorContextFromEvents } from "./negotiationHistory.js";

// ---------------------------------------------------------------------------
// Finalized-terms resolution helpers
// ---------------------------------------------------------------------------
// Shared by the post-negotiation nodes (Reward Setup [legacy], Payment Info
// [legacy] and Content Brief) that need to surface the closed-deal terms. Kept
// in its own module so the logic is decoupled from any single node executor.

/**
 * Resolve the final agreed fee for the deal — or `undefined` when NO genuine
 * agreed rate exists (CRITICAL-3).
 *
 * The negotiation persists the agreed rate on the ACCEPT NEGOTIATION_TURN event
 * (FIX-2); a brand APPROVE now does the same (CRITICAL-3). buildPriorContextFromEvents
 * surfaces the last rate we actually put on the table as `currentOffer`, which
 * for a closed deal is exactly the agreed fee.
 *
 * IMPORTANT (CRITICAL-3): this NO LONGER falls back to the negotiation band
 * (ceiling → floor). The old fallback meant a deal that closed without a recorded
 * rate would surface the INTERNAL CEILING as "the agreed fee" — a number the
 * brand/creator never agreed to — in the contract-forming Content Brief / reward
 * emails. Deterministic code must never invent a fee (PRINCIPLES.md). When there
 * is no real agreed rate this returns `undefined`, and the contract-forming
 * callers escalate to a human rather than stating a fabricated figure.
 *
 * `negotiationConfig` / `fallbackConfig` are retained in the signature (callers
 * pass them) but are no longer read for a fee fallback; kept so callers don't
 * churn and so a future non-fabricating source could use them if needed.
 */
export function resolveAgreedFee(
  events: Awaited<ReturnType<typeof listEventsByInstance>>,
  _negotiationConfig: Record<string, unknown> = {},
  _fallbackConfig: Record<string, unknown> = {},
): number | undefined {
  const prior = buildPriorContextFromEvents(events);
  return prior.currentOffer;
}

/** First finite number among the candidates, else undefined. */
export function firstNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

/** First non-empty string among the candidates, else undefined. */
export function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return undefined;
}
