import type { listEventsByInstance } from "../../db/index.js";
import { buildPriorContextFromEvents } from "./negotiationHistory.js";
import { resolveBand } from "../band.js";

// ---------------------------------------------------------------------------
// Finalized-terms resolution helpers
// ---------------------------------------------------------------------------
// Shared by the post-negotiation nodes (Reward Setup [legacy], Payment Info
// [legacy] and Content Brief) that need to surface the closed-deal terms. Kept
// in its own module so the logic is decoupled from any single node executor.

/**
 * Resolve the final agreed fee for the deal.
 *
 * The negotiation persists the agreed rate on the ACCEPT NEGOTIATION_TURN event
 * (FIX-2). buildPriorContextFromEvents surfaces the last rate we put on the
 * table as `currentOffer`, which for a closed deal is exactly the agreed fee.
 * Falls back to the negotiation band (ceiling → floor), so the email always has
 * a concrete number to show even for legacy/mocked instances. The band comes
 * from the NEGOTIATION node config (minBudget/maxBudget), with the calling
 * node's own config as a secondary fallback.
 */
export function resolveAgreedFee(
  events: Awaited<ReturnType<typeof listEventsByInstance>>,
  negotiationConfig: Record<string, unknown>,
  fallbackConfig: Record<string, unknown> = {},
): number | undefined {
  const prior = buildPriorContextFromEvents(events);
  if (prior.currentOffer !== undefined) return prior.currentOffer;
  const negBand = resolveBand(negotiationConfig);
  const fbBand = resolveBand(fallbackConfig);
  return negBand.ceiling ?? negBand.floor ?? fbBand.ceiling ?? fbBand.floor;
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
