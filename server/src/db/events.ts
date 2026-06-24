import type { Event, EventType, Prisma } from "@prisma/client";
import { prisma } from "./client.js";

/** Append a new event to the audit log. Never update or delete events. */
export async function appendEvent(data: Prisma.EventCreateInput): Promise<Event> {
  return prisma.event.create({ data });
}

export async function listEventsByInstance(
  instanceId: string,
  opts?: { limit?: number; type?: EventType },
): Promise<Event[]> {
  return prisma.event.findMany({
    where: {
      instanceId,
      ...(opts?.type ? { type: opts.type } : {}),
    },
    orderBy: { occurredAt: "asc" },
    ...(opts?.limit ? { take: opts.limit } : {}),
  });
}
