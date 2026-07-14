import { asc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { events } from "../src/db/schema.js";
async function main() {
  const id = process.argv[2]!;
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.instanceId, id))
    .orderBy(asc(events.occurredAt));
  for (const e of rows) {
    console.log(`${e.occurredAt.toISOString()}  ${e.type}`);
    console.log(`   ${JSON.stringify(e.payload)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
