import type { Message } from "../db/schema.js";
import { listMessagesByInstance } from "../db/messages.js";

// ---------------------------------------------------------------------------
// Thread context (Email Threading — E3)
// ---------------------------------------------------------------------------
// Given an instanceId, produce — in ONE DB read — the thread *state* the next
// outbound send needs: what to reply to, the thread's canonical subject, and the
// thread id. This is DATA, not presentation: the resolver never decides the
// outgoing subject string (that is `buildReplySubject`, a separate pure
// transform) and never sends or touches a provider. Keeping state and
// presentation on independent axes lets the `Re:` convention evolve without
// touching thread lookup, and vice versa (RFC Component section).

export interface ThreadContext {
  /** External id of the message this send replies to, or undefined → open a new
   *  thread. Maps 1:1 onto EmailSendOptions.replyToExternalId. */
  replyToExternalId?: string;
  /** The thread's canonical subject = the first outbound subject for the
   *  instance. undefined on the first outbound (there is no prior subject yet). */
  canonicalSubject?: string;
  /** Provider thread id for the instance, for the escalation deep-link (E6). A
   *  READ concern — deliberately NOT part of EmailSendOptions (ADR-2). */
  threadId?: string;
}

export interface ThreadContextResolver {
  resolve(instanceId: string): Promise<ThreadContext>;
}

// Injectable DB seam, mirroring the `SendOnceDeps` style so the resolver is unit
// testable with an in-memory message list — no provider, no live database.
export interface ThreadContextDeps {
  listMessagesByInstance(instanceId: string): Promise<Message[]>;
}

const defaultDeps: ThreadContextDeps = { listMessagesByInstance };

/**
 * Default resolver: one read of the instance's messages (ordered createdAt asc
 * by `listMessagesByInstance`) yields all three fields in memory.
 *
 * - `replyToExternalId` = the LAST row with a non-empty `externalMessageId`
 *   (D2: latest message, either direction). A reserved-but-unsent row carries no
 *   external id and is skipped, so we never reply to a message that never went
 *   out (E7). Empty string is treated as absent — we never emit
 *   `replyToExternalId: ""`.
 * - `canonicalSubject` = the FIRST outbound row's subject (the subject the
 *   thread opened with), undefined when there is no prior outbound.
 * - `threadId` = the reply-target row's `threadId`. All of an instance's
 *   messages share one threadId once set, so any row's is representative; taking
 *   the reply target's keeps it consistent with what we reply to.
 *
 * Degrades to "new thread" (all fields undefined) on empty history — never
 * throws for missing data (E7). A failing DB read is the caller's concern;
 * `sendOnce` (E5) treats a thrown resolve as empty context so delivery is never
 * blocked by a threading ambiguity.
 */
export class DefaultThreadContextResolver implements ThreadContextResolver {
  constructor(private readonly deps: ThreadContextDeps = defaultDeps) {}

  async resolve(instanceId: string): Promise<ThreadContext> {
    const rows = await this.deps.listMessagesByInstance(instanceId);

    // Last row (chronologically) that actually carries a provider external id.
    let replyTarget: Message | undefined;
    for (const row of rows) {
      if (row.externalMessageId) replyTarget = row;
    }

    // First outbound subject = the thread's canonical subject.
    const firstOutbound = rows.find((row) => row.direction === "OUTBOUND");

    const ctx: ThreadContext = {};
    if (replyTarget?.externalMessageId) {
      ctx.replyToExternalId = replyTarget.externalMessageId;
    }
    if (replyTarget?.threadId) {
      ctx.threadId = replyTarget.threadId;
    }
    if (firstOutbound?.subject) {
      ctx.canonicalSubject = firstOutbound.subject;
    }
    return ctx;
  }
}

// ---------------------------------------------------------------------------
// buildReplySubject — pure presentation policy (no I/O)
// ---------------------------------------------------------------------------

const RE_PREFIX = /^\s*re:\s*/i;

/**
 * Turn thread state into the outgoing subject.
 *
 * - No canonical subject (first outbound) → the draft's own subject, unchanged.
 * - Otherwise → the canonical subject with an idempotent `Re:` prefix: strip a
 *   single leading case-insensitive `re:` first, so a reply to an already-`Re:`
 *   canonical never becomes `Re: Re:`.
 *
 * Pure: same inputs → same output, no DB, no provider.
 */
export function buildReplySubject(
  canonicalSubject: string | undefined,
  draftSubject: string,
): string {
  if (canonicalSubject === undefined) return draftSubject;
  const base = canonicalSubject.replace(RE_PREFIX, "");
  return `Re: ${base}`;
}
