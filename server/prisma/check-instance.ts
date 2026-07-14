/**
 * Inspect a live-test instance: state, round, messages (with threadId), and the
 * last few events. Run: tsx prisma/check-instance.ts <instanceId>
 */
import { asc, desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { events, executionInstances, messages } from "../src/db/schema.js";

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: tsx prisma/check-instance.ts <instanceId>");

  const inst = (
    await db.select().from(executionInstances).where(eq(executionInstances.id, id)).limit(1)
  )[0];
  if (!inst) throw new Error(`instance ${id} not found`);

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.instanceId, id))
    .orderBy(asc(messages.createdAt));
  const recentEvents = await db
    .select()
    .from(events)
    .where(eq(events.instanceId, id))
    .orderBy(desc(events.occurredAt))
    .limit(6);

  console.log(`\nINSTANCE ${id}`);
  console.log(`  state=${inst.currentState}  node=${inst.currentNodeId}  round=${inst.negotiationRound}`);
  console.log(`\n  MESSAGES (${msgs.length}):`);
  for (const m of msgs) {
    console.log(
      `   [${m.direction}] ext=${m.externalMessageId ?? "-"} thread=${m.threadId ?? "-"} ` +
        `intent=${m.replyIntent ?? "-"} conf=${m.classifyConfidence ?? "-"}`,
    );
    const preview = (m.body ?? "").replace(/\s+/g, " ").slice(0, 140);
    if (preview) console.log(`       body: ${preview}${(m.body ?? "").length > 140 ? "…" : ""}`);
  }
  console.log(`\n  RECENT EVENTS (newest first):`);
  for (const e of recentEvents) {
    const p = JSON.stringify(e.payload);
    console.log(`   ${e.type}  ${p.length > 200 ? p.slice(0, 200) + "…" : p}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
