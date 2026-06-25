import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });
const prisma = new PrismaClient({ adapter });
async function main() {
  const id = process.argv[2]!;
  const events = await prisma.event.findMany({
    where: { instanceId: id },
    orderBy: { occurredAt: "asc" },
  });
  for (const e of events) {
    console.log(`${e.occurredAt.toISOString()}  ${e.type}`);
    console.log(`   ${JSON.stringify(e.payload)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
