/**
 * Reset a parked instance back to ENROLLED at the first (outreach) node and
 * delete its phantom outbound outreach row so a re-launch actually sends.
 *
 * Why delete the message row: sendOnce() reserves an OUTBOUND row keyed by
 * `outreach:<instanceId>` BEFORE calling the email provider. A prior send that
 * failed after reserving leaves that row behind with externalMessageId=NULL; on
 * re-run sendOnce hits the unique constraint and SKIPS the send. Deleting the
 * reserved row lets the next launch send for real.
 *
 * Run: tsx prisma/reset-to-enrolled.ts <instanceId>
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { executionInstances, messages, workflowVersions } from "../src/db/schema.js";

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: tsx prisma/reset-to-enrolled.ts <instanceId>");

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

  const graph = found.nodeGraph as Array<{ id: string; type: string; order: number }>;
  const firstNode = graph.slice().sort((a, b) => a.order - b.order)[0];
  const outreachNode = graph.find((n) => n.type === "INITIAL_OUTREACH") ?? firstNode;

  // Delete phantom outbound outreach rows (unsent reservations) so sendOnce
  // does not skip the send on re-launch.
  const delMsgs = await db
    .delete(messages)
    .where(
      and(
        eq(messages.instanceId, id),
        eq(messages.direction, "OUTBOUND"),
        isNull(messages.externalMessageId),
      ),
    )
    .returning({ id: messages.id });

  const updated = (
    await db
      .update(executionInstances)
      .set({
        currentState: "ENROLLED",
        currentNodeId: null,
        followUpCount: 0,
        negotiationRound: 0,
        dueAt: null,
        completedAt: null,
      })
      .where(eq(executionInstances.id, id))
      .returning()
  )[0]!;

  console.log(JSON.stringify({
    instanceId: updated.id,
    state: updated.currentState,
    node: updated.currentNodeId,
    deletedPhantomOutbound: delMsgs.length,
    outreachNodeId: outreachNode?.id,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
