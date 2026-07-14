/**
 * Fixture for the Phase 8 negotiation harness (npm run harness:phase8).
 *
 * The harness needs ≥7 ENROLLED instances of the seed version (wfv_seed_v1) to
 * assign one per scenario. The original db:seed used to provide these, but the
 * roster became CSV-only (creators are no longer seeded), so this one-off
 * creates 7 throwaway harness creators and (re-)enrolls them. Idempotent:
 * upserts by email / (version, creator) and resets each instance to ENROLLED.
 *
 * Run: npm run db:seed && npx tsx prisma/setup-phase8-harness.ts
 */
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { creators, executionInstances, workflowVersions } from "../src/db/schema.js";

const HARNESS_CREATORS = Array.from({ length: 7 }, (_, i) => ({
  name: `Harness Creator ${i + 1}`,
  email: `phase8-harness-${i + 1}@example.com`,
  handle: `harness${i + 1}`,
  platform: "Instagram",
  niche: "demo",
}));

async function main() {
  const version = (
    await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, "wfv_seed_v1"))
      .limit(1)
  )[0];
  if (!version) {
    throw new Error("wfv_seed_v1 not found — run `npm run db:seed` first.");
  }

  let enrolled = 0;
  for (const c of HARNESS_CREATORS) {
    const creator = (
      await db
        .insert(creators)
        .values(c)
        .onConflictDoUpdate({ target: creators.email, set: { name: c.name } })
        .returning()
    )[0]!;
    await db
      .insert(executionInstances)
      .values({
        workflowVersionId: version.id,
        creatorId: creator.id,
        currentState: "ENROLLED",
      })
      .onConflictDoUpdate({
        target: [executionInstances.workflowVersionId, executionInstances.creatorId],
        set: {
          currentState: "ENROLLED",
          currentNodeId: null,
          followUpCount: 0,
          negotiationRound: 0,
          dueAt: null,
          completedAt: null,
        },
      });
    enrolled++;
  }
  console.log(`Enrolled ${enrolled} harness creators into ${version.id}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
