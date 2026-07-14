/** List all campaigns, workflows, and instance counts currently in the DB. */
import { asc, count, desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import {
  campaigns,
  creators,
  executionInstances,
  workflows,
} from "../src/db/schema.js";

async function main() {
  const out: string[] = [];
  const allCampaigns = await db.select().from(campaigns).orderBy(asc(campaigns.createdAt));
  out.push(`CAMPAIGNS: ${allCampaigns.length}`);
  for (const c of allCampaigns) out.push(`  - ${c.name}  (brand=${c.brand})  id=${c.id}  created=${c.createdAt.toISOString()}`);

  const allWorkflows = await db.select().from(workflows).orderBy(asc(workflows.createdAt));
  out.push(`\nWORKFLOWS: ${allWorkflows.length}`);
  for (const w of allWorkflows) out.push(`  - ${w.name}  status=${w.status}  campaignId=${w.campaignId ?? "-"}  id=${w.id}`);

  const instCount = (await db.select({ n: count() }).from(executionInstances))[0]?.n ?? 0;
  out.push(`\nEXECUTION INSTANCES: ${instCount}`);
  const insts = await db
    .select({ instance: executionInstances, creator: creators })
    .from(executionInstances)
    .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
    .orderBy(desc(executionInstances.updatedAt))
    .limit(20);
  for (const { instance: i, creator } of insts) {
    out.push(`  · ${i.id}  ${creator.name} <${creator.email}>  state=${i.currentState}  wfv=${i.workflowVersionId}  updated=${i.updatedAt.toISOString()}`);
  }
  console.log(out.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
