import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });
const prisma = new PrismaClient({ adapter });
async function main() {
  const id = process.argv[2]!;
  const last = await prisma.message.findFirst({
    where: { instanceId: id, direction: "OUTBOUND" },
    orderBy: { createdAt: "desc" },
  });
  if (!last) { console.log("no outbound message"); return; }
  console.log(`messageId=${last.externalMessageId}  thread=${last.threadId}`);
  console.log("--- BODY ---");
  console.log(last.body);
  console.log("--- /BODY ---");
  // Leak audit
  const b = (last.body ?? "");
  console.log(`\nAUDIT: Pluvus=${/pluvus/i.test(b)}  pound£=${b.includes("£")}  has480=${/\b480\b/.test(b)}  has350=${/\b350\b/.test(b)}  band200or500=${/\b(200|500)\b/.test(b)}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
