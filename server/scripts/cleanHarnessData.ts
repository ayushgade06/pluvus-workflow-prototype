/**
 * P8 — Harness / test-data cleanup (single-operator go-live).
 *
 * The dev DB accumulates harness fixtures (phase8-harness-* creators, the Nylas
 * live-test creator, anything on a reserved *.example.com domain) that pollute
 * the operator dashboard, the /observability counts, and the payout metrics once
 * we go live against the same Neon DB. This script purges every row that hangs
 * off a TEST creator — its execution instances and their full Event / Message /
 * BrandNotification / PaymentInfo / attribution / payout cascade — then deletes
 * the test creators themselves, leaving real partners and the shared seed
 * workflow structure untouched.
 *
 * "Test creator" is defined ONLY by config/testData.ts (isTestEmail). Nothing
 * here widens that; a real creator can never be matched.
 *
 * SAFETY:
 *   - Dry-run by DEFAULT. Prints exactly what WOULD be deleted and exits 0.
 *     Pass --apply to actually delete.
 *   - --drain-queues additionally removes stale FAILED/completed jobs from the
 *     BullMQ queues so the "queue failure counters start clean" (P8 acceptance).
 *   - The whole DB purge runs in ONE transaction (all-or-nothing) reusing the
 *     exact FK-safe ordering as deleteCampaign (deleteInstanceCascade).
 *
 * Run:
 *   npx tsx scripts/cleanHarnessData.ts                 # dry run (default)
 *   npx tsx scripts/cleanHarnessData.ts --apply         # delete test DB rows
 *   npx tsx scripts/cleanHarnessData.ts --apply --drain-queues
 *   npx tsx scripts/cleanHarnessData.ts --drain-queues  # drain stale jobs only
 *
 * npm scripts: `db:clean:harness` (dry run), `db:clean:harness:apply` (apply).
 */
import { inArray } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { deleteInstanceCascade } from "../src/db/campaigns.js";
import { creators, executionInstances } from "../src/db/schema.js";
import { isTestEmail, TEST_DATA_CONVENTION } from "../src/config/testData.js";
import {
  getNodeExecutionQueue,
  getInboundEmailQueue,
  closeQueues,
} from "../src/workers/queues.js";

interface Options {
  apply: boolean;
  drainQueues: boolean;
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    drainQueues: argv.includes("--drain-queues"),
  };
}

/** Purge all DB rows owned by test creators. Returns a summary for logging. */
async function purgeTestData(apply: boolean): Promise<{
  testCreatorEmails: string[];
  instanceCount: number;
}> {
  // 1. Resolve test creators purely in code from the shared convention — never
  //    trust a hand-typed filter here.
  const allCreators = await db
    .select({ id: creators.id, email: creators.email })
    .from(creators);
  const testCreators = allCreators.filter((c) => isTestEmail(c.email));
  const testCreatorIds = testCreators.map((c) => c.id);

  if (testCreatorIds.length === 0) {
    return { testCreatorEmails: [], instanceCount: 0 };
  }

  // 2. Their instances (a creator may be enrolled in the shared seed version).
  const instanceRows = await db
    .select({ id: executionInstances.id })
    .from(executionInstances)
    .where(inArray(executionInstances.creatorId, testCreatorIds));
  const instanceIds = instanceRows.map((i) => i.id);

  if (apply) {
    // One transaction: instance cascade (reused, FK-safe) → the creators. We do
    // NOT delete the seed workflow/version/campaign — those are shared real
    // structure that a test creator merely enrolled into.
    await db.transaction(async (tx) => {
      await deleteInstanceCascade(tx, instanceIds);
      await tx.delete(creators).where(inArray(creators.id, testCreatorIds));
    });
  }

  return {
    testCreatorEmails: testCreators.map((c) => c.email).sort(),
    instanceCount: instanceIds.length,
  };
}

/**
 * Drain stale FAILED and orphaned COMPLETED jobs from both queues so the
 * /queues/health failed counter starts at zero. Uses BullMQ's clean() (grace=0
 * ⇒ every job of that status regardless of age) and obliterate-free so the
 * queue itself and any in-flight/waiting real jobs survive.
 */
async function drainQueues(apply: boolean): Promise<Record<string, number>> {
  const queues = {
    "node-execution": getNodeExecutionQueue(),
    "inbound-email": getInboundEmailQueue(),
  };
  const removed: Record<string, number> = {};
  for (const [name, q] of Object.entries(queues)) {
    const failedBefore = (await q.getJobCounts("failed")).failed ?? 0;
    if (apply) {
      // grace 0, high limit → remove ALL failed jobs; leave waiting/active alone.
      await q.clean(0, 10_000, "failed");
    }
    removed[name] = failedBefore;
  }
  return removed;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const mode = opts.apply ? "APPLY (destructive)" : "DRY RUN (no changes)";

  console.log("─".repeat(64));
  console.log(`P8 harness-data cleanup — ${mode}`);
  console.log("Test-data convention (config/testData.ts):");
  console.log(`  reserved domains : ${TEST_DATA_CONVENTION.reservedDomains.join(", ")}`);
  console.log(`  known emails     : ${TEST_DATA_CONVENTION.knownEmails.join(", ")}`);
  console.log(`  local markers    : ${TEST_DATA_CONVENTION.localPartMarkers.join(", ")}`);
  console.log("─".repeat(64));

  const summary = await purgeTestData(opts.apply);
  if (summary.testCreatorEmails.length === 0) {
    console.log("No test creators found — database is already clean.");
  } else {
    const verb = opts.apply ? "Deleted" : "Would delete";
    console.log(
      `${verb} ${summary.testCreatorEmails.length} test creator(s) ` +
        `and ${summary.instanceCount} execution instance(s) ` +
        `(+ their events/messages/notifications/payment info/partnerships/ledger):`,
    );
    for (const email of summary.testCreatorEmails) console.log(`  - ${email}`);
  }

  if (opts.drainQueues) {
    const drained = await drainQueues(opts.apply);
    const verb = opts.apply ? "Removed" : "Would remove";
    console.log("─".repeat(64));
    for (const [name, n] of Object.entries(drained)) {
      console.log(`${verb} ${n} failed job(s) from queue "${name}".`);
    }
  }

  console.log("─".repeat(64));
  if (!opts.apply) {
    console.log("Dry run only — re-run with --apply to make these changes.");
  } else {
    console.log("Cleanup complete.");
  }
}

main()
  .catch((e) => {
    console.error("[clean:harness] failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close queue connections first (only opened when --drain-queues), then the
    // pg pool, so the process exits cleanly instead of hanging on open sockets.
    await closeQueues().catch(() => {});
    await pool.end().catch(() => {});
  });
