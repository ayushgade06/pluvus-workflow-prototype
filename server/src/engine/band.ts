// ---------------------------------------------------------------------------
// Negotiation price-band resolver
// ---------------------------------------------------------------------------
// Two different config shapes carry the negotiation price band, and before this
// helper they were read inconsistently:
//
//   * seed.ts node graphs use  termFloor:{rate} / termCeiling:{rate}
//   * the Workflow Builder UI + templates use  minBudget / maxBudget (numbers)
//
// The negotiation request builder (providers.ts) and the output guard
// (outputGuard.ts) only ever read termFloor/termCeiling, so a workflow built
// through the UI sent an EMPTY band to the agent — floor defaulted to 0 and
// ceiling to +inf, which collapses the recommended offer to 0 and makes the
// whole accept/counter/escalate band logic inert. This resolver accepts EITHER
// shape so both paths produce the same NegotiationTerm band.
//
// Precedence: explicit termFloor/termCeiling (the lower-level, snapshot form)
// wins when present; otherwise fall back to minBudget/maxBudget. A term that
// resolves to nothing yields an empty {} so downstream defaulting (floor->0,
// ceiling->+inf) is unchanged for genuinely unconfigured nodes.

import type { NegotiationTerm } from "../adapters/negotiation/types.js";

function rateOfTerm(term: unknown): number | undefined {
  if (term && typeof term === "object") {
    const r = (term as Record<string, unknown>)["rate"];
    if (typeof r === "number" && Number.isFinite(r)) return r;
  }
  return undefined;
}

function numberField(config: Record<string, unknown>, key: string): number | undefined {
  const v = config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export interface ResolvedBand {
  termFloor: NegotiationTerm;
  termCeiling: NegotiationTerm;
  /** The floor rate as a plain number, if one was resolved. */
  floor: number | undefined;
  /** The ceiling rate as a plain number, if one was resolved. */
  ceiling: number | undefined;
}

/**
 * Resolve the negotiation price band from a node config, accepting either the
 * termFloor/termCeiling shape (seed snapshots) or minBudget/maxBudget (UI).
 * termFloor/termCeiling take precedence when present.
 */
export function resolveBand(config: Record<string, unknown>): ResolvedBand {
  const floor = rateOfTerm(config["termFloor"]) ?? numberField(config, "minBudget");
  const ceiling = rateOfTerm(config["termCeiling"]) ?? numberField(config, "maxBudget");

  // Preserve any non-rate fields (deliverables/timeline) already on an explicit
  // term object; otherwise build a minimal term carrying just the rate.
  const baseFloor = (config["termFloor"] ?? {}) as NegotiationTerm;
  const baseCeiling = (config["termCeiling"] ?? {}) as NegotiationTerm;

  return {
    termFloor: floor !== undefined ? { ...baseFloor, rate: floor } : baseFloor,
    termCeiling: ceiling !== undefined ? { ...baseCeiling, rate: ceiling } : baseCeiling,
    floor,
    ceiling,
  };
}
