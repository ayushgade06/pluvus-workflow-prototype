/** Quick lookup: AI Productivity campaign → workflow → version → instances. */
import { asc, count, eq, ilike } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import {
  campaigns,
  creators,
  executionInstances,
  messages,
  workflows,
  workflowVersions,
} from "../src/db/schema.js";

async function main() {
  const c = (
    await db
      .select()
      .from(campaigns)
      .where(ilike(campaigns.name, "%AI Productivity%"))
      .limit(1)
  )[0];
  if (!c) { console.log("no campaign"); return; }
  const out: string[] = [`CAMPAIGN ${c.name} id=${c.id}`];
  const wfs = await db.select().from(workflows).where(eq(workflows.campaignId, c.id));
  for (const wf of wfs) {
    out.push(`  WF ${wf.name} status=${wf.status}`);
    const versions = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, wf.id))
      .orderBy(asc(workflowVersions.version));
    for (const v of versions) {
      const insts = await db
        .select({ instance: executionInstances, creator: creators })
        .from(executionInstances)
        .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
        .where(eq(executionInstances.workflowVersionId, v.id));
      out.push(`    v${v.version} id=${v.id} instances=${insts.length}`);
      for (const { instance: i, creator } of insts) {
        const msgs =
          (
            await db
              .select({ n: count() })
              .from(messages)
              .where(eq(messages.instanceId, i.id))
          )[0]?.n ?? 0;
        out.push(`      · ${i.id}  ${creator.name} <${creator.email}>  state=${i.currentState} node=${i.currentNodeId ?? "-"} msgs=${msgs}`);
      }
    }
  }
  console.log(out.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
