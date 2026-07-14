/**
 * Reset a parked instance back to NEGOTIATING at the negotiation node so the
 * negotiation executor re-runs against the already-persisted inbound reply.
 * Used to re-test a negotiation turn after a code fix without sending a new
 * email. Run: tsx prisma/reset-to-negotiating.ts <instanceId>
 */
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { executionInstances, workflowVersions } from "../src/db/schema.js";

async function main() {
  const id = process.argv[2]!;
  const found = (
    await db
      .select({ instance: executionInstances, nodeGraph: workflowVersions.nodeGraph })
      .from(executionInstances)
      .innerJoin(
        workflowVersions,
        eq(executionInstances.workflowVersionId, workflowVersions.id),
      )
      .where(eq(executionInstances.id, id))
      .limit(1)
  )[0];
  if (!found) throw new Error(`instance ${id} not found`);

  const graph = found.nodeGraph as Array<{ id: string; type: string }>;
  const negNode = graph.find((n) => n.type === "NEGOTIATION");
  if (!negNode) throw new Error("no NEGOTIATION node in graph");

  const updated = (
    await db
      .update(executionInstances)
      .set({
        currentState: "NEGOTIATING",
        currentNodeId: negNode.id,
        // keep negotiationRound as-is (0) so this is treated as the first turn
      })
      .where(eq(executionInstances.id, id))
      .returning()
  )[0]!;
  console.log(JSON.stringify({
    instanceId: updated.id,
    state: updated.currentState,
    node: updated.currentNodeId,
    round: updated.negotiationRound,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
