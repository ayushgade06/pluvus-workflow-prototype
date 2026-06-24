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
