import type { Event } from "@prisma/client";
import type { PriorNegotiationContext, NegotiationHistoryEntryLite } from "../types.js";

// ---------------------------------------------------------------------------
// Negotiation history assembly (FIX-1 history threading + FIX-2 current offer)
// ---------------------------------------------------------------------------
// The agent service is stateless per call (key invariant). The executor — the
// only reader/writer of instance state — assembles the conversation so far from
// the append-only NEGOTIATION_TURN events and threads it into agent.negotiate().
//
// This is a pure function over already-fetched events so it can be unit-tested
// without a database.

type Payload = Record<string, unknown>;

const VALID_ACTIONS = new Set(["ACCEPT", "COUNTER", "REJECT", "ESCALATE", "PRESENT_OFFER"]);

function asPayload(p: unknown): Payload {
  return p && typeof p === "object" ? (p as Payload) : {};
}

/** Normalize an event payload's `outcome` (lowercase "counter" or uppercase
 *  "COUNTER" both appear historically) to the canonical action label. */
function normalizeAction(raw: unknown): NegotiationHistoryEntryLite["action"] | null {
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase();
  return VALID_ACTIONS.has(upper) ? (upper as NegotiationHistoryEntryLite["action"]) : null;
}

function asNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function asString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Build the prior-negotiation context from an instance's events.
 *
 * @param events  All events for the instance (any order). Only NEGOTIATION_TURN
 *                events are considered.
 * @returns history (chronological by `occurredAt`) and the most-recently
 *          proposed rate as `currentOffer`.
 */
export function buildPriorContextFromEvents(events: Event[]): PriorNegotiationContext {
  const turns = events
    .filter((e) => e.type === "NEGOTIATION_TURN")
    .slice()
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const history: NegotiationHistoryEntryLite[] = [];
  let currentOffer: number | undefined;

  for (const turn of turns) {
    const payload = asPayload(turn.payload);
    const action = normalizeAction(payload["outcome"]);
    if (!action) continue; // skip malformed/foreign payloads

    const round = asNumber(payload["round"]) ?? history.length;
    // The proposed rate is persisted as `rate` (added in FIX-2); tolerate its
    // absence for pre-FIX events.
    const rate = asNumber(payload["rate"]);
    const message = asString(payload["message"]);

    history.push({
      round,
      action,
      ...(rate !== undefined ? { rate } : {}),
      ...(message !== undefined ? { message } : {}),
    });

    // Track the last rate we actually put on the table (an offer we made).
    // ACCEPT/COUNTER/PRESENT_OFFER carry a proposed number; REJECT/ESCALATE do
    // not. PRESENT_OFFER (answering a "what's the rate?" question) is a genuine
    // offer on the table, so the next turn knows our standing number.
    if (rate !== undefined && (action === "ACCEPT" || action === "COUNTER" || action === "PRESENT_OFFER")) {
      currentOffer = rate;
    }
  }

  return { history, ...(currentOffer !== undefined ? { currentOffer } : {}) };
}
