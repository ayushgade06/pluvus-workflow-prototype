import { and, asc, eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import { events, type Event, type EventInsert, type EventType } from "./schema.js";

/** Append a new event to the audit log. Never update or delete events. */
export async function appendEvent(data: EventInsert): Promise<Event> {
  const rows = await db.insert(events).values(data).returning();
  return rows[0]!;
}

export async function listEventsByInstance(
  instanceId: string,
  opts?: { limit?: number; type?: EventType },
): Promise<Event[]> {
  const where = opts?.type
    ? and(eq(events.instanceId, instanceId), eq(events.type, opts.type))
    : eq(events.instanceId, instanceId);
  const query = db
    .select()
    .from(events)
    .where(where)
    .orderBy(asc(events.occurredAt));
  return opts?.limit ? query.limit(opts.limit) : query;
}
