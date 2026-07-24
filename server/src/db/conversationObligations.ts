import { and, asc, eq, inArray } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  conversationObligations,
  type ConversationObligation,
  type ConversationObligationStatus,
  type ObligationType,
} from "./schema.js";

// ---------------------------------------------------------------------------
// ConversationObligation access module (PLU-111)
// ---------------------------------------------------------------------------
// Durable creator questions + Pluvus commitments with an explicit lifecycle. See
// .claude/spec/conversation-obligations/PLAN.md. Every write is `client: Db |
// DbTx = db`-injectable so the create/update + reserve-time link run INSIDE
// stepInstance's transaction (invariant #5, §4.6), while the flush-time terminal
// transition runs in the updateMessageSent path (the SENT gate, §4.5 step 2).
//
// Terminal vs non-terminal (used everywhere below):
//   Non-terminal (stays in AI context): OPEN, DEFERRED, ESCALATED
//   Terminal   (drops out; resolvedAt set): ANSWERED, COMPLETED, CANCELED,
//                                            NO_LONGER_RELEVANT

/** The statuses that keep an obligation live (fed to AI + hold the dedup slot). */
export const NON_TERMINAL_STATUSES: ConversationObligationStatus[] = [
  "OPEN",
  "DEFERRED",
  "ESCALATED",
];

/** The statuses that retire an obligation (set resolvedAt; free the dedup slot). */
export const TERMINAL_STATUSES: ConversationObligationStatus[] = [
  "ANSWERED",
  "COMPLETED",
  "CANCELED",
  "NO_LONGER_RELEVANT",
];

export function isTerminalObligationStatus(
  status: ConversationObligationStatus,
): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Non-terminal obligations for an instance (OPEN/DEFERRED/ESCALATED), oldest-
 * first. This is the AI-context read (§4.7) and the dedup lookup source. Ordered
 * by createdAt so the must-answer checklist keeps a stable, chronological order.
 */
export async function listOpenObligationsByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<ConversationObligation[]> {
  return client
    .select()
    .from(conversationObligations)
    .where(
      and(
        eq(conversationObligations.instanceId, instanceId),
        inArray(conversationObligations.status, NON_TERMINAL_STATUSES),
      ),
    )
    .orderBy(asc(conversationObligations.createdAt));
}

/**
 * Every obligation for an instance (any status), oldest-first — for the
 * observability surface (§4.9). Includes terminal rows so an operator can see
 * the full history of what was asked and how it resolved.
 */
export async function listObligationsByInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<ConversationObligation[]> {
  return client
    .select()
    .from(conversationObligations)
    .where(eq(conversationObligations.instanceId, instanceId))
    .orderBy(asc(conversationObligations.createdAt));
}

// ---------------------------------------------------------------------------
// Question obligations — create / update (§4.3, §4.4)
// ---------------------------------------------------------------------------

export interface UpsertQuestionArgs {
  instanceId: string;
  normalizedKey: string;
  originalText: string;
  sourceMessageId?: string | null;
  category?: string | null;
}

/**
 * Insert a CREATOR_QUESTION obligation, or touch the existing NON-TERMINAL row
 * with the same (instanceId, CREATOR_QUESTION, normalizedKey) — a re-ask of a
 * still-open question (§4.3). Conservative by construction: exact-normalized
 * match only, scoped to non-terminal rows, so an ANSWERED-then-re-asked question
 * (the dedup slot is free) correctly mints a FRESH open row.
 *
 * The partial-unique index (`ConversationObligation_open_key`) is the DB
 * backstop against a concurrent double-insert (a BullMQ retry racing the same
 * turn): the second insert hits the constraint, we catch isUniqueViolation and
 * fall through to the touch path, so the ledger never double-lists a question.
 */
export async function upsertQuestionObligation(
  args: UpsertQuestionArgs,
  client: Db | DbTx = db,
): Promise<ConversationObligation> {
  const existing = await findOpenByKey(
    args.instanceId,
    "CREATOR_QUESTION",
    args.normalizedKey,
    client,
  );
  if (existing) {
    // Re-ask of a still-open question — touch updatedAt (drizzle stamps it via
    // $onUpdate) and keep originalText as the FIRST wording (audit). Do NOT
    // insert. Carry forward a sourceMessageId/category only if we didn't have one.
    const patch: Partial<{ sourceMessageId: string | null; category: string | null }> = {};
    if (!existing.sourceMessageId && args.sourceMessageId) {
      patch.sourceMessageId = args.sourceMessageId;
    }
    if (!existing.category && args.category) {
      patch.category = args.category;
    }
    const rows = await client
      .update(conversationObligations)
      // updatedAt is bumped by $onUpdate even when patch is empty (a real re-ask
      // signal); include it explicitly so an empty-patch update still touches it.
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(conversationObligations.id, existing.id))
      .returning();
    return rows[0] ?? existing;
  }

  try {
    const rows = await client
      .insert(conversationObligations)
      .values({
        instanceId: args.instanceId,
        type: "CREATOR_QUESTION",
        status: "OPEN",
        originalText: args.originalText,
        normalizedKey: args.normalizedKey,
        ...(args.category ? { category: args.category } : {}),
        ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId } : {}),
      })
      .returning();
    return rows[0]!;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A concurrent writer won the race — the row is now open under our key.
    const raced = await findOpenByKey(
      args.instanceId,
      "CREATOR_QUESTION",
      args.normalizedKey,
      client,
    );
    if (raced) return raced;
    throw err;
  }
}

/** Lookup a single non-terminal obligation by its dedup key. */
async function findOpenByKey(
  instanceId: string,
  type: ObligationType,
  normalizedKey: string,
  client: Db | DbTx = db,
): Promise<ConversationObligation | null> {
  const rows = await client
    .select()
    .from(conversationObligations)
    .where(
      and(
        eq(conversationObligations.instanceId, instanceId),
        eq(conversationObligations.type, type),
        eq(conversationObligations.normalizedKey, normalizedKey),
        inArray(conversationObligations.status, NON_TERMINAL_STATUSES),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Commitments — mint (§4.8)
// ---------------------------------------------------------------------------

export interface MintCommitmentArgs {
  instanceId: string;
  originalText: string;
  normalizedKey: string;
  sourceMessageId?: string | null;
  category?: string | null;
}

/**
 * Mint a PLUVUS_COMMITMENT obligation (OPEN). Called at flush time when a sent
 * draft DEFERRED a question ("we'll get back to you on X") — the deferral answer
 * becomes a durable promise we owe. Idempotent on the partial-unique key: a
 * retried flush that re-mints the same commitment hits the constraint and
 * returns the existing open row rather than duplicating it.
 */
export async function mintCommitmentObligation(
  args: MintCommitmentArgs,
  client: Db | DbTx = db,
): Promise<ConversationObligation> {
  const existing = await findOpenByKey(
    args.instanceId,
    "PLUVUS_COMMITMENT",
    args.normalizedKey,
    client,
  );
  if (existing) return existing;
  try {
    const rows = await client
      .insert(conversationObligations)
      .values({
        instanceId: args.instanceId,
        type: "PLUVUS_COMMITMENT",
        status: "OPEN",
        originalText: args.originalText,
        normalizedKey: args.normalizedKey,
        ...(args.category ? { category: args.category } : {}),
        ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId } : {}),
      })
      .returning();
    return rows[0]!;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await findOpenByKey(
      args.instanceId,
      "PLUVUS_COMMITMENT",
      args.normalizedKey,
      client,
    );
    if (raced) return raced;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reserve-time link (§4.5 step 1)
// ---------------------------------------------------------------------------

/**
 * Stamp `resolutionMessageId` on a set of NON-TERMINAL obligations — the
 * "this pending send is the one that will answer these" intended link. Status is
 * left UNCHANGED (the resolution fires only at flush, when sentAt is set). Only
 * touches non-terminal rows so an already-resolved obligation is never
 * re-pointed. Runs inside the turn's commit transaction.
 */
export async function linkResolutionMessage(
  obligationIds: string[],
  resolutionMessageId: string,
  client: Db | DbTx = db,
): Promise<number> {
  if (obligationIds.length === 0) return 0;
  const rows = await client
    .update(conversationObligations)
    .set({ resolutionMessageId, updatedAt: new Date() })
    .where(
      and(
        inArray(conversationObligations.id, obligationIds),
        inArray(conversationObligations.status, NON_TERMINAL_STATUSES),
      ),
    )
    .returning({ id: conversationObligations.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Flush-time resolution — the SENT gate (§4.5 step 2, §4.8)
// ---------------------------------------------------------------------------

/**
 * A per-obligation decision the caller (flush) supplies from scanning the SENT
 * body against the agent's deferral vocabulary (§4.8): does this send actually
 * ANSWER the question, or DEFER it (→ becomes a commitment)?
 */
export interface DeferralClassifier {
  /**
   * Return `true` when the sent copy DEFERRED this question (a promise, not an
   * answer). The obligation then goes DEFERRED (stays open) and a
   * PLUVUS_COMMITMENT is minted. Return `false` (the default) to ANSWER it.
   */
  isDeferred(obligation: ConversationObligation): boolean;
  /** Normalized dedup key for the minted commitment (defaults to the question's). */
  commitmentKey?(obligation: ConversationObligation): string;
}

export interface ResolveByMessageResult {
  answered: number;
  completed: number;
  deferred: number;
  mintedCommitments: number;
}

/**
 * Resolve every NON-TERMINAL obligation pointed at `messageId` now that the row
 * has actually been SENT (§4.5 step 2). This is THE crux: it runs in the same
 * update path that stamps `sentAt`, so an ANSWERED/COMPLETED can never accompany
 * a row without a real `sentAt`.
 *
 *   CREATOR_QUESTION  → ANSWERED   (resolvedAt, resolutionSource="ai"), UNLESS
 *                       the classifier says it was DEFERRED → the question goes
 *                       DEFERRED (non-terminal, stays open) and a new
 *                       PLUVUS_COMMITMENT is minted (§4.8).
 *   PLUVUS_COMMITMENT → COMPLETED  (a later fulfilling send).
 *
 * Idempotent: it only flips NON-TERMINAL rows, so a BullMQ retry of the flush
 * finds them already terminal (or DEFERRED) and re-does nothing meaningful — a
 * re-run's deferral re-mint is absorbed by mintCommitmentObligation's dedup.
 */
export async function resolveObligationsByResolutionMessage(
  messageId: string,
  client: Db | DbTx = db,
  classifier?: DeferralClassifier,
): Promise<ResolveByMessageResult> {
  const rows = await client
    .select()
    .from(conversationObligations)
    .where(
      and(
        eq(conversationObligations.resolutionMessageId, messageId),
        inArray(conversationObligations.status, NON_TERMINAL_STATUSES),
      ),
    );

  const result: ResolveByMessageResult = {
    answered: 0,
    completed: 0,
    deferred: 0,
    mintedCommitments: 0,
  };
  const now = new Date();

  for (const ob of rows) {
    if (ob.type === "PLUVUS_COMMITMENT") {
      await client
        .update(conversationObligations)
        .set({
          status: "COMPLETED",
          resolvedAt: now,
          resolutionSource: "ai",
          updatedAt: now,
        })
        .where(eq(conversationObligations.id, ob.id));
      result.completed += 1;
      continue;
    }

    // CREATOR_QUESTION — answered vs deferred.
    const deferred = classifier?.isDeferred(ob) ?? false;
    if (deferred) {
      // The question stays OPEN as DEFERRED (non-terminal) — nothing is lost —
      // and the promise becomes a durable commitment (§4.8). CLEAR the resolution
      // link: this message deferred (did not answer) it, so a retry of this exact
      // flush must NOT re-select and re-process it; it now waits for a FUTURE send
      // to answer it (the next turn's reserve re-links it via linkResolutionMessage).
      await client
        .update(conversationObligations)
        .set({ status: "DEFERRED", resolutionMessageId: null, updatedAt: now })
        .where(eq(conversationObligations.id, ob.id));
      result.deferred += 1;
      const before = result.mintedCommitments;
      const commitmentKey =
        classifier?.commitmentKey?.(ob) ?? ob.normalizedKey;
      await mintCommitmentObligation(
        {
          instanceId: ob.instanceId,
          originalText: ob.originalText,
          normalizedKey: commitmentKey,
          sourceMessageId: messageId,
          ...(ob.category ? { category: ob.category } : {}),
        },
        client,
      );
      // mintCommitmentObligation dedups on a retry; count best-effort (a re-mint
      // returns the existing row but is still a mint from the caller's view).
      result.mintedCommitments = before + 1;
      continue;
    }

    await client
      .update(conversationObligations)
      .set({
        status: "ANSWERED",
        resolvedAt: now,
        resolutionSource: "ai",
        updatedAt: now,
      })
      .where(eq(conversationObligations.id, ob.id));
    result.answered += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Escalation (§4.2) — non-terminal, nothing lost
// ---------------------------------------------------------------------------

/**
 * Move NON-TERMINAL obligations to ESCALATED (non-terminal). Used when an
 * always-escalate topic fires: the question stays in the AI context AND surfaces
 * in the Manual Queue. Does NOT set resolvedAt and does NOT free the dedup slot.
 */
export async function escalateObligations(
  obligationIds: string[],
  client: Db | DbTx = db,
): Promise<number> {
  if (obligationIds.length === 0) return 0;
  const rows = await client
    .update(conversationObligations)
    .set({ status: "ESCALATED", updatedAt: new Date() })
    .where(
      and(
        inArray(conversationObligations.id, obligationIds),
        inArray(conversationObligations.status, NON_TERMINAL_STATUSES),
      ),
    )
    .returning({ id: conversationObligations.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Operator manual resolution (§4.9)
// ---------------------------------------------------------------------------

/** The terminal statuses an operator may set by hand. */
export type ManualResolveStatus = Extract<
  ConversationObligationStatus,
  "ANSWERED" | "COMPLETED" | "CANCELED" | "NO_LONGER_RELEVANT"
>;

/**
 * Resolve an obligation manually to a terminal status (operator or system).
 *
 * Idempotent by predicate: the update matches only a NON-TERMINAL row, so
 * resolving an already-terminal obligation no-ops and returns the row as it
 * stands (the caller can treat it as success rather than an error).
 */
export async function resolveObligationManual(
  id: string,
  opts: { status: ManualResolveStatus; resolution?: string | null },
  source: "operator" | "system" = "operator",
  client: Db | DbTx = db,
): Promise<ConversationObligation | null> {
  const now = new Date();
  const rows = await client
    .update(conversationObligations)
    .set({
      status: opts.status,
      resolvedAt: now,
      resolutionSource: source,
      ...(opts.resolution !== undefined ? { resolution: opts.resolution } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(conversationObligations.id, id),
        inArray(conversationObligations.status, NON_TERMINAL_STATUSES),
      ),
    )
    .returning();
  if (rows[0]) return rows[0];
  // Already terminal (or not found) — return the current row, if any.
  const existing = await client
    .select()
    .from(conversationObligations)
    .where(eq(conversationObligations.id, id))
    .limit(1);
  return existing[0] ?? null;
}
