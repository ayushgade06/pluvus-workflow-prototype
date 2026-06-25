/**
 * Inspect a live-test instance: state, round, messages (with threadId), and the
 * last few events. Run: tsx prisma/check-instance.ts <instanceId>
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });
const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });
const prisma = new PrismaClient({ adapter });

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: tsx prisma/check-instance.ts <instanceId>");

  const inst = await prisma.executionInstance.findUnique({ where: { id } });
  if (!inst) throw new Error(`instance ${id} not found`);

  const messages = await prisma.message.findMany({
    where: { instanceId: id },
    orderBy: { createdAt: "asc" },
  });
  const events = await prisma.event.findMany({
    where: { instanceId: id },
    orderBy: { occurredAt: "desc" },
    take: 6,
  });

  console.log(`\nINSTANCE ${id}`);
  console.log(`  state=${inst.currentState}  node=${inst.currentNodeId}  round=${inst.negotiationRound}`);
  console.log(`\n  MESSAGES (${messages.length}):`);
  for (const m of messages) {
    console.log(
      `   [${m.direction}] ext=${m.externalMessageId ?? "-"} thread=${m.threadId ?? "-"} ` +
        `intent=${m.replyIntent ?? "-"} conf=${m.classifyConfidence ?? "-"}`,
    );
    const preview = (m.body ?? "").replace(/\s+/g, " ").slice(0, 140);
    if (preview) console.log(`       body: ${preview}${(m.body ?? "").length > 140 ? "…" : ""}`);
  }
  console.log(`\n  RECENT EVENTS (newest first):`);
  for (const e of events) {
    const p = JSON.stringify(e.payload);
    console.log(`   ${e.type}  ${p.length > 200 ? p.slice(0, 200) + "…" : p}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
