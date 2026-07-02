/**
 * Reset a parked instance back to ENROLLED at the first (outreach) node and
 * delete its phantom outbound outreach row so a re-launch actually sends.
 *
 * Why delete the message row: sendOnce() reserves an OUTBOUND row keyed by
 * `outreach:<instanceId>` BEFORE calling the email provider. A prior send that
 * failed after reserving leaves that row behind with externalMessageId=NULL; on
 * re-run sendOnce hits the unique constraint (P2002) and SKIPS the send. Deleting
 * the reserved row lets the next launch send for real.
 *
 * Run: tsx prisma/reset-to-enrolled.ts <instanceId>
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });
const prisma = new PrismaClient({ adapter });

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: tsx prisma/reset-to-enrolled.ts <instanceId>");

  const inst = await prisma.executionInstance.findUnique({
    where: { id },
    include: { workflowVersion: true },
  });
  if (!inst) throw new Error(`instance ${id} not found`);

  const graph = inst.workflowVersion.nodeGraph as Array<{ id: string; type: string; order: number }>;
  const firstNode = graph.slice().sort((a, b) => a.order - b.order)[0];
  const outreachNode = graph.find((n) => n.type === "INITIAL_OUTREACH") ?? firstNode;

  // Delete phantom outbound outreach rows (unsent reservations) so sendOnce
  // does not skip the send on re-launch.
  const delMsgs = await prisma.message.deleteMany({
    where: { instanceId: id, direction: "OUTBOUND", externalMessageId: null },
  });

  const updated = await prisma.executionInstance.update({
    where: { id },
    data: {
      currentState: "ENROLLED",
      currentNodeId: null,
      followUpCount: 0,
      negotiationRound: 0,
      dueAt: null,
      completedAt: null,
    },
  });

  console.log(JSON.stringify({
    instanceId: updated.id,
    state: updated.currentState,
    node: updated.currentNodeId,
    deletedPhantomOutbound: delMsgs.count,
    outreachNodeId: outreachNode?.id,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
