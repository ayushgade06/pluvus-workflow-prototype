import { and, asc, desc, eq } from "drizzle-orm";
import { db, pool } from "./src/db/drizzle.js";
import { events, executionInstances, messages } from "./src/db/schema.js";
const inst = (
  await db
    .select()
    .from(executionInstances)
    .where(eq(executionInstances.workflowVersionId, "cmr1veof2000k9kc35a6yb9ah"))
    .orderBy(desc(executionInstances.updatedAt))
    .limit(1)
)[0];
if (!inst) { console.log("no instance"); process.exit(0); }
console.log("STATE:", inst.currentState, "| round:", inst.negotiationRound, "| node:", inst.currentNodeId);
const eventRows = await db
  .select()
  .from(events)
  .where(eq(events.instanceId, inst.id))
  .orderBy(asc(events.occurredAt));
console.log("\n=== EVENTS ===");
for (const e of eventRows) console.log(`[${e.occurredAt.toISOString().slice(11,19)}] ${e.type}`, JSON.stringify(e.payload).slice(0,180));
const out = await db
  .select()
  .from(messages)
  .where(and(eq(messages.instanceId, inst.id), eq(messages.direction, "OUTBOUND")))
  .orderBy(asc(messages.createdAt));
console.log("\n=== ALL OUTBOUND (in order) ===");
for (const m of out) {
  console.log(`\n### [${m.createdAt.toISOString().slice(11,19)}] idem=${m.idempotencyKey} subject="${m.subject}"`);
  console.log((m.body ?? "").replace(/&#39;/g,"'").slice(0, 500));
}
await pool.end();
process.exit(0);
