/**
 * Unit tests for the HARD-R1 reconciliation sweep. Proves it re-enqueues stuck
 * transient-state instances with a deterministic, dedupe-friendly triggerRef and
 * tolerates a per-row failure. Injects the DB + queue seam so it runs with no
 * live DB / Redis. Run:  npx tsx src/scheduler/reconciliation.test.ts
 */

import assert from "node:assert/strict";
import type { ExecutionInstance } from "../db/schema.js";
import { reconcileStuckInstances, type ReconciliationDeps } from "./reconciliation.js";
import type { NodeExecutionJobData } from "../workers/jobs.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function inst(id: string, state: string, updatedAt: Date): ExecutionInstance {
  return {
    id,
    workflowVersionId: "wv-1",
    creatorId: `creator-${id}`,
    currentState: state,
    currentNodeId: "node-x",
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    enrolledAt: updatedAt,
    completedAt: null,
    createdAt: updatedAt,
    updatedAt,
  } as unknown as ExecutionInstance;
}

function makeDeps(stuck: ExecutionInstance[], opts?: { failFor?: string }): {
  deps: ReconciliationDeps;
  enqueued: NodeExecutionJobData[];
} {
  const enqueued: NodeExecutionJobData[] = [];
  const deps: ReconciliationDeps = {
    async listStuckInstances() {
      return stuck;
    },
    async enqueueNodeExecution(data) {
      if (opts?.failFor && data.instanceId === opts.failFor) {
        throw new Error("queue down");
      }
      enqueued.push(data);
    },
  };
  return { deps, enqueued };
}

async function main() {
  console.log("\nreconcileStuckInstances (HARD-R1)\n");

  const NOW = new Date("2026-07-09T12:00:00.000Z");
  const OLD = new Date("2026-07-09T11:00:00.000Z"); // 1h ago — well past the stale window

  await test("re-enqueues each stuck instance keyed on its current state", async () => {
    const { deps, enqueued } = makeDeps([
      inst("a", "ACCEPTED", OLD),
      inst("b", "REPLY_RECEIVED", OLD),
    ]);
    const count = await reconcileStuckInstances(NOW, deps);
    assert.equal(count, 2);
    assert.equal(enqueued.length, 2);
    assert.equal(enqueued[0]!.expectedState, "ACCEPTED");
    assert.equal(enqueued[1]!.expectedState, "REPLY_RECEIVED");
  });

  await test("triggerRef is deterministic per (instance, state, time-bucket)", async () => {
    // Two sweeps in the same bucket produce the SAME triggerRef, so BullMQ dedupes
    // the re-enqueue instead of piling up jobs for a still-stuck instance.
    const { deps: d1, enqueued: e1 } = makeDeps([inst("a", "ACCEPTED", OLD)]);
    const { deps: d2, enqueued: e2 } = makeDeps([inst("a", "ACCEPTED", OLD)]);
    await reconcileStuckInstances(NOW, d1);
    await reconcileStuckInstances(new Date(NOW.getTime() + 1000), d2); // same bucket
    assert.equal(e1[0]!.triggerRef, e2[0]!.triggerRef);
    // Colon-free (BullMQ jobId requirement).
    assert.ok(!e1[0]!.triggerRef.includes(":"));
  });

  await test("empty stuck set is a no-op returning 0", async () => {
    const { deps, enqueued } = makeDeps([]);
    assert.equal(await reconcileStuckInstances(NOW, deps), 0);
    assert.equal(enqueued.length, 0);
  });

  await test("a per-row enqueue failure does not abort the batch", async () => {
    const { deps, enqueued } = makeDeps(
      [inst("a", "ACCEPTED", OLD), inst("b", "NEGOTIATING", OLD)],
      { failFor: "a" },
    );
    const count = await reconcileStuckInstances(NOW, deps);
    // 'a' threw; 'b' still enqueued. count reflects only successful re-enqueues.
    assert.equal(count, 1);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.instanceId, "b");
  });

  await test("a DB query failure returns 0 without throwing", async () => {
    const deps: ReconciliationDeps = {
      async listStuckInstances() {
        throw new Error("db down");
      },
      async enqueueNodeExecution() {
        /* unreachable */
      },
    };
    assert.equal(await reconcileStuckInstances(NOW, deps), 0);
  });

  console.log(`\n${n} passed\n`);
}

await main();
