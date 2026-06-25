/**
 * Reset a parked instance back to NEGOTIATING at the negotiation node so the
 * negotiation executor re-runs against the already-persisted inbound reply.
 * Used to re-test a negotiation turn after a code fix without sending a new
 * email. Run: tsx prisma/reset-to-negotiating.ts <instanceId>
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });
const prisma = new PrismaClient({ adapter });

async function main() {
  const id = process.argv[2]!;
  const inst = await prisma.executionInstance.findUnique({
    where: { id },
    include: { workflowVersion: true },
  });
  if (!inst) throw new Error(`instance ${id} not found`);

  const graph = inst.workflowVersion.nodeGraph as Array<{ id: string; type: string }>;
  const negNode = graph.find((n) => n.type === "NEGOTIATION");
  if (!negNode) throw new Error("no NEGOTIATION node in graph");

  const updated = await prisma.executionInstance.update({
    where: { id },
    data: {
      currentState: "NEGOTIATING",
      currentNodeId: negNode.id,
      // keep negotiationRound as-is (0) so this is treated as the first turn
    },
  });
  console.log(JSON.stringify({
    instanceId: updated.id,
    state: updated.currentState,
    node: updated.currentNodeId,
    round: updated.negotiationRound,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
