/** List all campaigns, workflows, and instance counts currently in the DB. */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env["DATABASE_URL"] }) });

async function main() {
  const out: string[] = [];
  const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: "asc" } });
  out.push(`CAMPAIGNS: ${campaigns.length}`);
  for (const c of campaigns) out.push(`  - ${c.name}  (brand=${c.brand})  id=${c.id}  created=${c.createdAt.toISOString()}`);

  const workflows = await prisma.workflow.findMany({ orderBy: { createdAt: "asc" } });
  out.push(`\nWORKFLOWS: ${workflows.length}`);
  for (const w of workflows) out.push(`  - ${w.name}  status=${w.status}  campaignId=${w.campaignId ?? "-"}  id=${w.id}`);

  const instCount = await prisma.executionInstance.count();
  out.push(`\nEXECUTION INSTANCES: ${instCount}`);
  const insts = await prisma.executionInstance.findMany({
    include: { creator: true },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  for (const i of insts) {
    out.push(`  · ${i.id}  ${i.creator.name} <${i.creator.email}>  state=${i.currentState}  wfv=${i.workflowVersionId}  updated=${i.updatedAt.toISOString()}`);
  }
  console.log(out.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
