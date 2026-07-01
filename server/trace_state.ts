import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
import { prisma } from "./src/db/client.js";
const inst = await prisma.executionInstance.findFirst({
  where: { workflowVersionId: "cmr1veof2000k9kc35a6yb9ah" },
  orderBy: { updatedAt: "desc" },
});
if (!inst) { console.log("no instance"); process.exit(0); }
console.log("STATE:", inst.currentState, "| round:", inst.negotiationRound, "| node:", inst.currentNodeId);
const events = await prisma.event.findMany({ where: { instanceId: inst.id }, orderBy: { occurredAt: "asc" } });
console.log("\n=== EVENTS ===");
for (const e of events) console.log(`[${e.occurredAt.toISOString().slice(11,19)}] ${e.type}`, JSON.stringify(e.payload).slice(0,180));
const out = await prisma.message.findMany({ where: { instanceId: inst.id, direction: "OUTBOUND" }, orderBy: { createdAt: "asc" } });
console.log("\n=== ALL OUTBOUND (in order) ===");
for (const m of out) {
  console.log(`\n### [${m.createdAt.toISOString().slice(11,19)}] idem=${m.idempotencyKey} subject="${m.subject}"`);
  console.log((m.body ?? "").replace(/&#39;/g,"'").slice(0, 500));
}
process.exit(0);
