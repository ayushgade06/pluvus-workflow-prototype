import { asc, eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import { messages, type Message, type MessageInsert } from "./schema.js";

export async function createMessage(data: MessageInsert): Promise<Message> {
  const rows = await db.insert(messages).values(data).returning();
  return rows[0]!;
}

export async function findMessageByExternalId(
  externalMessageId: string,
): Promise<Message | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.externalMessageId, externalMessageId))
    .limit(1);
  return rows[0] ?? null;
}

/** Find an outbound message by its deterministic pre-send idempotency key
 *  (FIX-11). Used to detect a send that already happened before a crash, so the
 *  retry does not double-send. */
export async function findMessageByIdempotencyKey(
  idempotencyKey: string,
): Promise<Message | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0] ?? null;
}

/** Finalize a reserved outbound message after the email actually sent (FIX-11):
 *  attach the provider's message/thread id and stamp sentAt. */
export async function updateMessageSent(
  id: string,
  data: { externalMessageId: string; threadId: string },
): Promise<Message> {
  const rows = await db
    .update(messages)
    .set({
      externalMessageId: data.externalMessageId,
      threadId: data.threadId,
      sentAt: new Date(),
    })
    .where(eq(messages.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) {
    // Prisma threw P2025 here; a reserved row must exist.
    throw new Error(`Message ${id} not found`);
  }
  return updated;
}

/**
 * Mark an INBOUND reply as fully processed (CRITICAL-6). Called once the inbound
 * handler completes (persist → transition → step). The idempotency short-circuit
 * checks processedAt, so a row that was persisted but not processed (a crash
 * mid-handler) is re-processed on retry rather than skipped. Best-effort by
 * externalMessageId; a no-op if the row is already gone.
 */
export async function markMessageProcessed(externalMessageId: string): Promise<void> {
  await db
    .update(messages)
    .set({ processedAt: new Date() })
    .where(eq(messages.externalMessageId, externalMessageId));
}

/** Find all messages in a thread. Used by Nylas webhook handler (Phase 6)
 *  to correlate an inbound reply to the right ExecutionInstance. */
export async function findMessagesByThreadId(threadId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));
}

export async function listMessagesByInstance(instanceId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.instanceId, instanceId))
    .orderBy(asc(messages.createdAt));
}
