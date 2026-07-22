import type { Event, Message } from "../../db/schema.js";
import type { PriorNegotiationContext, NegotiationHistoryEntryLite } from "../types.js";
import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import { extractReplyText } from "./replyText.js";

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

// ---------------------------------------------------------------------------
// PLU-85: both-sides transcript sourced from Message rows (what was communicated)
// ---------------------------------------------------------------------------
// buildPriorContextFromEvents (above) feeds /negotiate the DECISION history —
// event-sourced by design (why the system decided). It is LEFT UNCHANGED.
//
// The both-sides transcript threaded into /draft (HARD-N2) and /negotiate (F-H1)
// is a different thing: a record of what was actually COMMUNICATED. It must be
// built from `Message` rows, not events, because `event.payload.message` is the
// AI's decision-step DRAFT — it can diverge from the utterance the creator
// actually received (operator edit, template change, a reserved-but-unsent /
// stranded delayed send, an eventless operator/transactional send). Sourcing the
// transcript from events makes the model reason against a history that may never
// have happened. Sourcing it from sent Message rows fixes that.
//
// This builder therefore:
//   - takes OUR side from OUTBOUND Message rows that were actually delivered
//     (`sentAt !== null`) — reserved-but-unsent / stranded / rolled-back rows
//     are dropped (they have `sentAt === null`);
//   - takes the CREATOR side from INBOUND rows (unchanged), via extractReplyText;
//   - ENRICHES each outbound entry with `round`/`action`/`rate` by joining the
//     sent row to its owning NEGOTIATION_TURN event (a Message row has `body` but
//     not those fields) — text/timing are canonical, event fields enrich;
//   - orders by real delivery time (`sentAt` / `receivedAt`, `createdAt` fallback);
//   - carries the source `messageId` for auditability.
//
// `brandReplyMsgIds` are inbound rows that are actually the BRAND answering an
// escalation (A1/A2), not the creator — excluded here so the brand's "approve"
// never appears as a creator turn.

/** A dated item to sort our-turns and creator-messages into one timeline. */
interface DatedEntry {
  at: number;
  entry: DraftHistoryEntry;
}

/** Enrichment recovered from the owning NEGOTIATION_TURN event for a sent
 *  outbound row (a Message has `body` but not these). All optional — an eventless
 *  send (operator/manual/transactional) resolves to an empty enrichment and is
 *  still included, text-only. */
interface OutboundEnrichment {
  round?: number;
  action?: NegotiationHistoryEntryLite["action"];
  rate?: number;
}

/** The idempotencyKey outcome token → canonical action. The outbound send is
 *  reserved with `negotiation:<token>:<instanceId>:<round>[:<inboundId>]`
 *  (see negotiation.ts reserveAiReply). `close` is the courteous max-rounds
 *  close email — a REJECT from the creator's point of view. */
const KEY_TOKEN_TO_ACTION: Record<string, NegotiationHistoryEntryLite["action"]> = {
  counter_offer: "COUNTER",
  acceptance: "ACCEPT",
  close: "REJECT",
  present: "PRESENT_OFFER",
};

/** Parse `round` + `action` from an outbound row's negotiation idempotencyKey.
 *  Returns null for a non-negotiation / malformed / absent key (an eventless
 *  operator or transactional send), in which case the row is included text-only. */
function parseNegotiationKey(
  key: string | null,
): { action: NegotiationHistoryEntryLite["action"]; round: number } | null {
  if (!key || !key.startsWith("negotiation:")) return null;
  // negotiation:<token>:<instanceId>:<round>[:<inboundId>]
  const parts = key.split(":");
  if (parts.length < 4) return null;
  const token = parts[1] ?? "";
  const action = KEY_TOKEN_TO_ACTION[token];
  if (!action) return null;
  // The round is the segment AFTER the instanceId. For `present` an optional
  // trailing `:<inboundId>` may follow, so the round is parts[3] regardless.
  const round = asNumber(Number(parts[3]));
  if (round === undefined) return null;
  return { action, round };
}

/** Index NEGOTIATION_TURN events by `round` so a sent outbound row can recover
 *  its `rate` (and confirm the action) from the owning turn. Keyed by round;
 *  each round maps to that round's turns (usually one, but a round can carry a
 *  PRESENT_OFFER before the decision — hence an array, matched by action). */
function indexEventsByRound(events: Event[]): Map<number, { action: NegotiationHistoryEntryLite["action"] | null; rate?: number }[]> {
  const byRound = new Map<number, { action: NegotiationHistoryEntryLite["action"] | null; rate?: number }[]>();
  for (const e of events) {
    if (e.type !== "NEGOTIATION_TURN") continue;
    const payload = asPayload(e.payload);
    const round = asNumber(payload["round"]);
    if (round === undefined) continue;
    const action = normalizeAction(payload["outcome"]);
    const rate = asNumber(payload["rate"]);
    const list = byRound.get(round) ?? [];
    list.push({ action, ...(rate !== undefined ? { rate } : {}) });
    byRound.set(round, list);
  }
  return byRound;
}

/** Recover round/action/rate for a sent outbound row (§4.3, the enrich-join).
 *  Strategy A: parse the idempotencyKey for round+action, then pull `rate` from
 *  the matching NEGOTIATION_TURN event (same round, matching or unknown action).
 *  Graceful degradation: an eventless / unkeyed send returns an empty
 *  enrichment and is still rendered (text-only). */
function enrichOutbound(
  row: Message,
  eventsByRound: Map<number, { action: NegotiationHistoryEntryLite["action"] | null; rate?: number }[]>,
): OutboundEnrichment {
  const parsed = parseNegotiationKey(row.idempotencyKey);
  if (!parsed) return {};
  const { action, round } = parsed;
  // Match the owning turn by round; prefer the event whose action agrees with
  // the key, else the first turn at that round (a `close` send maps to REJECT but
  // its event outcome is `escalate`/max_rounds, so don't require action equality).
  const turns = eventsByRound.get(round) ?? [];
  const match = turns.find((t) => t.action === action) ?? turns[0];
  const rate = match?.rate;
  return { round, action, ...(rate !== undefined ? { rate } : {}) };
}

/**
 * Build the both-sides transcript from Message rows (PLU-85).
 *
 * @param messages   ALL Message rows for the instance (both directions) — the
 *                   outbound rows are already loaded by `loadCreatorInbounds`.
 * @param excludedMessageIds  Legacy brand-reply externalMessageIds to exclude
 *                   from the creator side (a brand escalation reply persisted
 *                   INBOUND must not read as a creator turn).
 * @param events     NEGOTIATION_TURN events, used ONLY to enrich outbound entries
 *                   with round/action/rate. The events remain the separate
 *                   decision history (buildPriorContextFromEvents) untouched.
 */
export function buildDraftHistory(
  messages: Message[],
  excludedMessageIds: Set<string>,
  events: Event[],
): DraftHistoryEntry[] {
  const items: DatedEntry[] = [];
  const eventsByRound = indexEventsByRound(events);

  for (const m of messages) {
    if (m.direction === "OUTBOUND") {
      // Invariant #2: an outbound turn counts only if it was actually delivered.
      // Reserved-but-unsent (delay window), stranded/failed, and rolled-back
      // orphan rows all have `sentAt === null` and are dropped here.
      if (m.sentAt === null) continue;
      // We composed our own copy clean — use the body RAW (running the inbound
      // reply extractor on it could truncate legitimate content). §4.4.
      const body = m.body ?? "";
      if (!body.trim()) continue;
      const enrich = enrichOutbound(m, eventsByRound);
      const at = (m.sentAt ?? m.createdAt).getTime();
      items.push({
        at,
        entry: {
          role: "us",
          ...(enrich.round !== undefined ? { round: enrich.round } : {}),
          ...(enrich.action ? { action: enrich.action } : {}),
          ...(enrich.rate !== undefined ? { rate: enrich.rate } : {}),
          message: body,
          messageId: m.id,
        },
      });
      continue;
    }

    // INBOUND (creator side) — unchanged behavior.
    if (m.direction !== "INBOUND") continue;
    if (m.externalMessageId && excludedMessageIds.has(m.externalMessageId)) continue;
    const text = extractReplyText(m.body ?? "");
    if (!text.trim()) continue;
    // Prefer the received time; fall back to createdAt for older rows.
    const at = (m.receivedAt ?? m.createdAt).getTime();
    items.push({ at, entry: { role: "creator", message: text, messageId: m.id } });
  }

  items.sort((a, b) => a.at - b.at);
  return items.map((i) => i.entry);
}

// HARD-N2 answered-questions ledger. Each NEGOTIATION_TURN event persists the
// creator's questions for that turn (payload.creatorQuestions). A question the
// creator raised in an EARLIER round that we never carried forward should be
// re-surfaced, not silently dropped. We can't perfectly prove "answered", so the
// ledger is a conservative diff: prior-round questions that are NOT among this
// turn's questions are treated as still-open and re-listed for the copywriter
// (which will answer or honestly defer each). De-duplicated case-insensitively.
export function computeOpenQuestions(
  events: Event[],
  currentQuestions: string[] | undefined,
): string[] {
  const current = new Set((currentQuestions ?? []).map((q) => q.trim().toLowerCase()));
  const open: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== "NEGOTIATION_TURN") continue;
    const payload = asPayload(e.payload);
    const qs = payload["creatorQuestions"];
    if (!Array.isArray(qs)) continue;
    for (const q of qs) {
      if (typeof q !== "string") continue;
      const norm = q.trim();
      if (!norm) continue;
      const key = norm.toLowerCase();
      if (current.has(key) || seen.has(key)) continue;
      seen.add(key);
      open.push(norm);
    }
  }
  return open;
}
