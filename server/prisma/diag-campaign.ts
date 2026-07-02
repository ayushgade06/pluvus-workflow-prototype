/** Quick lookup: AI Productivity campaign → workflow → version → instances. */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"] }) });

async function main() {
  const c = await prisma.campaign.findFirst({
    where: { name: { contains: "AI Productivity", mode: "insensitive" } },
    include: { workflows: { include: { versions: true } } },
  });
  if (!c) { console.log("no campaign"); return; }
  const out: string[] = [`CAMPAIGN ${c.name} id=${c.id}`];
  for (const wf of c.workflows) {
    out.push(`  WF ${wf.name} status=${wf.status}`);
    for (const v of wf.versions) {
      const insts = await prisma.executionInstance.findMany({
        where: { workflowVersionId: v.id },
        include: { creator: true },
      });
      out.push(`    v${v.version} id=${v.id} instances=${insts.length}`);
      for (const i of insts) {
        const msgs = await prisma.message.count({ where: { instanceId: i.id } });
        out.push(`      · ${i.id}  ${i.creator.name} <${i.creator.email}>  state=${i.currentState} node=${i.currentNodeId ?? "-"} msgs=${msgs}`);
      }
    }
  }
  console.log(out.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
