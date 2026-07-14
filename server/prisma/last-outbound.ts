import { and, desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { messages } from "../src/db/schema.js";
async function main() {
  const id = process.argv[2]!;
  const last = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.instanceId, id), eq(messages.direction, "OUTBOUND")))
      .orderBy(desc(messages.createdAt))
      .limit(1)
  )[0];
  if (!last) { console.log("no outbound message"); return; }
  console.log(`messageId=${last.externalMessageId}  thread=${last.threadId}`);
  console.log("--- BODY ---");
  console.log(last.body);
  console.log("--- /BODY ---");
  // Leak audit
  const b = (last.body ?? "");
  console.log(`\nAUDIT: Pluvus=${/pluvus/i.test(b)}  pound£=${b.includes("£")}  has480=${/\b480\b/.test(b)}  has350=${/\b350\b/.test(b)}  band200or500=${/\b(200|500)\b/.test(b)}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
