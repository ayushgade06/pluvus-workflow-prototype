import {
  createMessage as createMessageDb,
  findMessageByIdempotencyKey as findByKeyDb,
  updateMessageSent as updateMessageSentDb,
} from "../../db/index.js";
import { isUniqueViolation } from "../../db/errors.js";
import type { Creator, Message, MessageInsert } from "../../db/schema.js";
import type { EmailDraft } from "../types.js";
import type { IEmailProvider, EmailRecipient } from "../providers.js";

// ---------------------------------------------------------------------------
// Idempotent outbound send (FIX-11, generalized)
// ---------------------------------------------------------------------------
// Reserve-before-send: insert the OUTBOUND message row with a deterministic
// idempotencyKey BEFORE calling email.send(), using the row's unique constraint
// as the lock. The window being closed: a crash between email.send() and the
// row write would, on BullMQ retry, re-run the executor and send a SECOND email.
//
//   1. Reserve — createMessage with idempotencyKey (no provider id yet).
//      A unique-violation (P2002) means a prior attempt already reserved/sent
//      this exact send → skip the send and return the prior identifiers so the
//      caller's event payload is identical on the retry.
//   2. Send.
//   3. Finalize the reserved row with the provider's messageId/threadId.
//
// This is the same pattern the negotiation executor used inline for ACCEPT /
// COUNTER; lifted here so initial-outreach and follow-up share it.

export interface SentResult {
  messageId: string;
  threadId: string;
  /** True when a prior attempt had already sent this exact message (the send was
   *  skipped on this attempt). False on a first, fresh send. */
  alreadySent: boolean;
}

// DB seam — injectable so the reserve→send→finalize sequencing (incl. the P2002
// branch) is unit-testable without a live database. Defaults to the real db.
export interface SendOnceDeps {
  createMessage(data: MessageInsert): Promise<Message>;
  findMessageByIdempotencyKey(key: string): Promise<Message | null>;
  updateMessageSent(
    id: string,
    data: { externalMessageId: string; threadId: string },
  ): Promise<Message>;
}

const defaultDeps: SendOnceDeps = {
  createMessage: createMessageDb,
  findMessageByIdempotencyKey: findByKeyDb,
  updateMessageSent: updateMessageSentDb,
};

/**
 * Send an outbound email at most once for the given idempotency key.
 *
 * On a fresh send: reserves the row, sends, finalizes, returns the provider
 * identifiers with alreadySent=false.
 *
 * On a retry after a prior COMPLETED send: the reservation insert hits P2002; we
 * read the already-reserved row, see it carries a provider externalMessageId, and
 * return its identifiers with alreadySent=true WITHOUT sending again.
 *
 * BUG-E3: if the prior attempt crashed AFTER reserving but BEFORE sending, the
 * reserved row has NO externalMessageId — the email was never actually sent. The
 * old behavior returned alreadySent=true here, permanently DROPPING a
 * contract-forming email (Content Brief / payout-request / welcome), leaving the
 * instance to advance and then wait forever on a link the creator never received.
 * We now RE-ATTEMPT the send in that case and finalize the existing reserved row,
 * so a reserve-then-crash is recovered on the BullMQ retry instead of lost.
 */
export async function sendOnce(
  email: IEmailProvider,
  instanceId: string,
  creator: Creator,
  draft: EmailDraft,
  idempotencyKey: string,
  deps: SendOnceDeps = defaultDeps,
  // Optional explicit recipient (brand outbound — CRITICAL-2). When set, the
  // email is addressed to the brand rather than the creator; the reserved
  // Message row still belongs to the instance so the brand's reply correlates by
  // threadId. An optional Reply-To on the recipient is carried through.
  recipient?: EmailRecipient,
): Promise<SentResult> {
  // Step 1 — reserve.
  let reserved;
  try {
    reserved = await deps.createMessage({
      instanceId,
      direction: "OUTBOUND",
      subject: draft.subject,
      body: draft.body,
      idempotencyKey,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // A prior attempt already reserved this key. Distinguish two cases:
      const prior = await deps.findMessageByIdempotencyKey(idempotencyKey);
      const priorSent =
        typeof prior?.externalMessageId === "string" && prior.externalMessageId !== "";
      if (priorSent) {
        // (a) The prior attempt COMPLETED the send — do not send again.
        return {
          messageId: prior!.externalMessageId!,
          threadId: prior?.threadId ?? "",
          alreadySent: true,
        };
      }
      if (prior) {
        // (b) BUG-E3: reserved but NEVER sent (prior attempt crashed between
        // reserve and send). Re-attempt the send now and finalize the existing
        // reserved row, rather than dropping the email. This is safe: the row's
        // unique idempotencyKey still prevents a duplicate row, and a genuinely
        // sent message would have taken branch (a) above.
        const { messageId, threadId } = await email.send(draft, creator, recipient);
        await deps.updateMessageSent(prior.id, { externalMessageId: messageId, threadId });
        return { messageId, threadId, alreadySent: false };
      }
      // Defensive: unique violation but no row found on re-read (shouldn't happen).
      // Surface a safe "already sent" rather than risk a duplicate.
      return { messageId: "", threadId: "", alreadySent: true };
    }
    throw err;
  }

  // Step 2 — send (guarded by the committed reservation).
  const { messageId, threadId } = await email.send(draft, creator, recipient);

  // Step 3 — finalize the reserved row with the provider's identifiers.
  await deps.updateMessageSent(reserved.id, { externalMessageId: messageId, threadId });

  return { messageId, threadId, alreadySent: false };
}
