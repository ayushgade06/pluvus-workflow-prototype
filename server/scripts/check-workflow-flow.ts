/**
 * One-off: which post-negotiation flow is each published workflow version on?
 *   MERGED  — CONTENT_BRIEF node, no REWARD_SETUP/PAYMENT_INFO (one-email flow)
 *   LEGACY  — REWARD_SETUP and/or PAYMENT_INFO nodes present (three-email chain)
 * Run: cd server && npx tsx scripts/check-workflow-flow.ts
 */
import { desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { workflows, workflowVersions, executionInstances } from "../src/db/schema.js";

const versions = await db
  .select({
    versionId: workflowVersions.id,
    version: workflowVersions.version,
    publishedAt: workflowVersions.publishedAt,
    nodeGraph: workflowVersions.nodeGraph,
    workflowName: workflows.name,
    workflowStatus: workflows.status,
  })
  .from(workflowVersions)
  .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
  .orderBy(desc(workflowVersions.publishedAt))
  .limit(5);

for (const v of versions) {
  const nodes = Array.isArray(v.nodeGraph) ? (v.nodeGraph as Array<{ type: string }>) : [];
  const types = nodes.map((n) => n.type);
  const legacy = types.includes("REWARD_SETUP") || types.includes("PAYMENT_INFO");
  const merged = types.includes("CONTENT_BRIEF") && !legacy;
  const flow = merged ? "MERGED (one email)" : legacy ? "LEGACY (three emails)" : "NEITHER (no post-negotiation node)";

  const instances = await db
    .select({ id: executionInstances.id, state: executionInstances.currentState })
    .from(executionInstances)
    .where(eq(executionInstances.workflowVersionId, v.versionId));

  console.log(`\n${v.workflowName} — v${v.version} (${v.workflowStatus})`);
  console.log(`  published: ${v.publishedAt?.toISOString() ?? "—"}`);
  console.log(`  nodes:     ${types.join(" → ")}`);
  console.log(`  flow:      ${flow}`);
  console.log(`  instances: ${instances.length}${instances.length ? " — " + instances.map((i) => i.state).join(", ") : ""}`);
}

await pool.end();
