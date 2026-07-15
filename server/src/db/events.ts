import { and, asc, eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { events, type Event, type EventInsert, type EventType } from "./schema.js";

/**
 * Append a new event to the audit log. Never update or delete events.
 *
 * `client` is injectable so the caller can enlist the append in an open
 * transaction (W-7): the OCC state write and the STATE_TRANSITION / money-trail
 * event append must commit together, or a crash between them can lose an
 * ACCEPT's agreed rate. Defaults to the top-level `db` when no tx is passed.
 */
export async function appendEvent(
  data: EventInsert,
  client: Db | DbTx = db,
): Promise<Event> {
  const rows = await client.insert(events).values(data).returning();
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
