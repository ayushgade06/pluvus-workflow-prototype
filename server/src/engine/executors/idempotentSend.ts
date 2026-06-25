import {
  createMessage as createMessageDb,
  findMessageByIdempotencyKey as findByKeyDb,
  updateMessageSent as updateMessageSentDb,
} from "../../db/index.js";
import type { Creator, Message, Prisma } from "@prisma/client";
import type { EmailDraft } from "../types.js";
import type { IEmailProvider } from "../providers.js";

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
  createMessage(data: Prisma.MessageCreateInput): Promise<Message>;
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

// Prisma unique-constraint violation is error code P2002.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Send an outbound email at most once for the given idempotency key.
 *
 * On a fresh send: reserves the row, sends, finalizes, returns the provider
 * identifiers with alreadySent=false.
 *
 * On a retry after a prior send: the reservation insert hits P2002; we read the
 * already-reserved row and return its identifiers with alreadySent=true, WITHOUT
 * sending again. (If the prior attempt crashed after reserving but before
 * sending, the row has no externalMessageId yet; we surface empty strings and
 * alreadySent=true — a safe missed send, never a duplicate.)
 */
export async function sendOnce(
  email: IEmailProvider,
  instanceId: string,
  creator: Creator,
  draft: EmailDraft,
  idempotencyKey: string,
  deps: SendOnceDeps = defaultDeps,
): Promise<SentResult> {
  // Step 1 — reserve.
  let reserved;
  try {
    reserved = await deps.createMessage({
      instance: { connect: { id: instanceId } },
      direction: "OUTBOUND",
      subject: draft.subject,
      body: draft.body,
      idempotencyKey,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Already reserved/sent on a prior attempt — do not send again.
      const prior = await deps.findMessageByIdempotencyKey(idempotencyKey);
      return {
        messageId: prior?.externalMessageId ?? "",
        threadId: prior?.threadId ?? "",
        alreadySent: true,
      };
    }
    throw err;
  }

  // Step 2 — send (guarded by the committed reservation).
  const { messageId, threadId } = await email.send(draft, creator);

  // Step 3 — finalize the reserved row with the provider's identifiers.
  await deps.updateMessageSent(reserved.id, { externalMessageId: messageId, threadId });

  return { messageId, threadId, alreadySent: false };
}
