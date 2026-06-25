import type { Message, Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export async function createMessage(data: Prisma.MessageCreateInput): Promise<Message> {
  return prisma.message.create({ data });
}

export async function findMessageByExternalId(
  externalMessageId: string,
): Promise<Message | null> {
  return prisma.message.findUnique({ where: { externalMessageId } });
}

/** Find an outbound message by its deterministic pre-send idempotency key
 *  (FIX-11). Used to detect a send that already happened before a crash, so the
 *  retry does not double-send. */
export async function findMessageByIdempotencyKey(
  idempotencyKey: string,
): Promise<Message | null> {
  return prisma.message.findUnique({ where: { idempotencyKey } });
}

/** Finalize a reserved outbound message after the email actually sent (FIX-11):
 *  attach the provider's message/thread id and stamp sentAt. */
export async function updateMessageSent(
  id: string,
  data: { externalMessageId: string; threadId: string },
): Promise<Message> {
  return prisma.message.update({
    where: { id },
    data: {
      externalMessageId: data.externalMessageId,
      threadId: data.threadId,
      sentAt: new Date(),
    },
  });
}

/** Find all messages in a thread. Used by Nylas webhook handler (Phase 6)
 *  to correlate an inbound reply to the right ExecutionInstance. */
export async function findMessagesByThreadId(threadId: string): Promise<Message[]> {
  return prisma.message.findMany({
    where: { threadId },
    orderBy: { createdAt: "asc" },
  });
}

export async function listMessagesByInstance(instanceId: string): Promise<Message[]> {
  return prisma.message.findMany({
    where: { instanceId },
    orderBy: { createdAt: "asc" },
  });
}
