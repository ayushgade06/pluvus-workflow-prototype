import type { Event, Message } from "../../db/schema.js";
import type { PriorNegotiationContext, NegotiationHistoryEntryLite } from "../types.js";
import type { DraftHistoryEntry } from "../../adapters/negotiation/types.js";
import { extractReplyText } from "./replyText.js";

// drafting-humanization (§Conversation State): the closed vocabulary a term may
// be flagged with in `changedFields`. Mirrors the agent-side vocabulary. Only the
// fee is negotiated per-turn in this system (commission/perk/deliverables/timeline
// are FIXED campaign config), so `computeChangedFields` only ever emits "fee" —
// but the vocabulary is kept complete for parity with the agent and forward use.
export type ChangedField = "fee" | "commission" | "deliverables" | "timeline" | "perk";
export type RelationshipWarmth = "new" | "warming" | "established";

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
// HARD-N2: full-conversation history for the copywriter (/draft)
// ---------------------------------------------------------------------------
// buildPriorContextFromEvents (above) feeds /negotiate the DECISION history
// (our-side turns only — that's all the money decision needs). /draft needs
// MORE: the creator's own words too, so the copy can stay consistent with the
// prior emails and not repeat wording or contradict an earlier statement. This
// builder interleaves our NEGOTIATION_TURN events and the creator's inbound
// Message rows into one chronological transcript.
//
// `brandReplyMsgIds` are inbound rows that are actually the BRAND answering an
// escalation (A1/A2), not the creator — the executor already collects these to
// exclude them from `latestCreatorInbound`; we exclude them here too so the
// brand's "approve" never appears as a creator turn.

/** A dated item to sort our-turns and creator-messages into one timeline. */
interface DatedEntry {
  at: number;
  entry: DraftHistoryEntry;
}

export function buildDraftHistory(
  events: Event[],
  creatorMessages: Message[],
  brandReplyMsgIds: Set<string>,
): DraftHistoryEntry[] {
  const items: DatedEntry[] = [];

  for (const e of events) {
    if (e.type !== "NEGOTIATION_TURN") continue;
    const payload = asPayload(e.payload);
    const action = normalizeAction(payload["outcome"]);
    const message = asString(payload["message"]);
    // Only turns that actually SENT copy are useful to the copywriter; a
    // draft-failure escalation with no message contributes nothing.
    if (!message) continue;
    const round = asNumber(payload["round"]);
    const rate = asNumber(payload["rate"]);
    items.push({
      at: e.occurredAt.getTime(),
      entry: {
        role: "us",
        ...(round !== undefined ? { round } : {}),
        ...(action ? { action } : {}),
        ...(rate !== undefined ? { rate } : {}),
        message,
      },
    });
  }

  for (const m of creatorMessages) {
    if (m.direction !== "INBOUND") continue;
    if (m.externalMessageId && brandReplyMsgIds.has(m.externalMessageId)) continue;
    const text = extractReplyText(m.body ?? "");
    if (!text.trim()) continue;
    // Prefer the received time; fall back to createdAt for older rows.
    const at = (m.receivedAt ?? m.createdAt).getTime();
    items.push({ at, entry: { role: "creator", message: text } });
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

// ---------------------------------------------------------------------------
// drafting-humanization (§Conversation State): the two STYLE hints for /draft
// ---------------------------------------------------------------------------
// Both are purely stylistic — the money decision never reads them — and both
// default so an unset value reproduces today's copy exactly. Pure functions over
// already-fetched context so they're unit-testable without a DB.

/**
 * Which offer terms actually CHANGED this turn, so the offer copy can state the
 * delta instead of restating the full state (§Repetition Reduction).
 *
 * Only the fixed FEE is negotiated per-turn here (commission / perk / deliverables
 * / timeline are fixed campaign config, never re-proposed), so this diffs the rate
 * we're putting on the table this turn against the last rate we offered
 * (`priorContext.currentOffer`, tracked by buildPriorContextFromEvents). Returns
 * ["fee"] when the fee is being presented for the FIRST time (no prior offer) or
 * differs from our last offer; [] when it's unchanged or absent — in which case
 * the agent omits the delta hint and falls back to "restate only what was asked",
 * i.e. today's behavior.
 */
export function computeChangedFields(
  priorContext: PriorNegotiationContext,
  proposedRate: number | undefined,
): ChangedField[] {
  if (proposedRate === undefined || !Number.isFinite(proposedRate)) return [];
  const lastOffer = priorContext.currentOffer;
  // First offer (no prior rate on the table) → the fee is news. A changed rate
  // vs our last offer → news. Same rate as last time → not news (don't restate).
  if (lastOffer === undefined || lastOffer !== proposedRate) return ["fee"];
  return [];
}

/**
 * Coarse relationship-warmth for the offer email's tone (§Progressive Conversation
 * Behaviour). Derived from round count + a cheap cooperativeness read, never from
 * anything confidential:
 *   "new"         — round <= 1 (first offer; today's round-1 tone).
 *   "warming"     — mid-thread and engaged (default once past round 1).
 *   "established" — a cooperative back-and-forth that's deep in the thread: the
 *                   creator has engaged over multiple rounds AND either moved
 *                   toward our number or we're near the round ceiling (closing out).
 *
 * `creatorMovedToward` is the caller's optional read of "did the creator concede
 * toward us" (e.g. their ask dropped). Absent/false is safe — warmth then steps up
 * to "established" only via thread depth, never below the round-derived rung. The
 * agent takes the WARMER of this hint and what `round` implies, so this can only
 * add warmth, never cool the email.
 */
export function computeRelationshipWarmth(args: {
  round: number;
  maxRounds: number;
  priorTurnCount: number;
  creatorMovedToward?: boolean;
}): RelationshipWarmth {
  const { round, maxRounds, priorTurnCount, creatorMovedToward } = args;
  if (round <= 1) return "new";
  // Engaged = we've actually exchanged prior turns (not a one-shot). Deep = we're
  // at least a third of the way through the round budget (maxRounds <= 0 means
  // unlimited, so depth alone can't trigger "established" there — cooperation can).
  const engaged = priorTurnCount >= 1;
  const deep = maxRounds > 0 && round >= Math.max(2, Math.ceil(maxRounds / 3));
  if (engaged && (creatorMovedToward === true || deep)) return "established";
  return "warming";
}
