/**
 * OCC race test for updateInstanceStateConditional — the backstop the whole
 * engine's state machine leans on (callers branch on "did my expected-state
 * update match a row?").
 *
 * This test runs against a REAL Postgres (PGlite, embedded/in-memory) with the
 * REAL schema: every Prisma migration in prisma/migrations is applied verbatim,
 * so the table the update hits is byte-identical to the live Neon one — same
 * NOT NULL columns with no DB defaults (Prisma generated ids/updatedAt
 * client-side), same enums, same constraints. That also proves the Drizzle
 * schema's $defaultFn compensations (cuid2 ids, updatedAt stamps) satisfy the
 * live DDL on insert.
 *
 * Run:  npx tsx --test src/db/instances.occ.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { updateInstanceStateConditional } from "./instances.js";
import type { Db } from "./drizzle.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");

/** Apply every Prisma migration in order. Statements are executed one at a
 *  time: ALTER TYPE ... ADD VALUE may not share an implicit transaction with
 *  a statement that uses the new value. Prisma's generated SQL is plain DDL
 *  (no DO blocks / function bodies), so splitting on `;` is safe. */
async function applyPrismaMigrations(pg: PGlite): Promise<number> {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  let applied = 0;
  for (const folder of folders) {
    const sql = readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");
    // Drop full-line comments FIRST (Prisma's comment prose can contain `;`,
    // which would corrupt the statement split), then split on `;`.
    const withoutComments = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const statements = withoutComments
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await pg.exec(stmt);
    }
    applied++;
  }
  return applied;
}

async function main(): Promise<void> {
  const pg = new PGlite();
  const migrated = await applyPrismaMigrations(pg);
  console.log(`  (applied ${migrated} Prisma migrations to embedded Postgres)`);
  // Same drizzle API surface as the Neon client; only the driver differs.
  const pgdb = drizzle(pg, { schema }) as unknown as Db;

  // ── Seed one instance through the real constraints ────────────────────────
  // Inserts deliberately omit id/createdAt/updatedAt: ids and @updatedAt
  // columns have NO db default, so this passing proves the schema-level
  // $defaultFn compensations.
  const [creator] = await pgdb
    .insert(schema.creators)
    .values({ name: "Race Test Creator", email: "occ-race@test.local" })
    .returning();
  const [workflow] = await pgdb
    .insert(schema.workflows)
    .values({ name: "OCC Race Workflow" })
    .returning();
  const [version] = await pgdb
    .insert(schema.workflowVersions)
    .values({ workflowId: workflow!.id, version: 1, nodeGraph: [] })
    .returning();
  const [instance] = await pgdb
    .insert(schema.executionInstances)
    .values({ workflowVersionId: version!.id, creatorId: creator!.id })
    .returning();

  await test("insert generated client-side id + updatedAt (Prisma-magic parity)", async () => {
    assert.ok(instance!.id.length >= 20, "cuid-style id was generated");
    assert.ok(instance!.updatedAt instanceof Date, "updatedAt stamped on insert");
    assert.equal(instance!.currentState, "ENROLLED");
  });

  await test("winner: expected-state update matches and advances", async () => {
    const won = await updateInstanceStateConditional(
      instance!.id,
      "ENROLLED",
      { currentState: "OUTREACH_SENT", currentNodeId: "node-outreach" },
      pgdb,
    );
    assert.ok(won, "update with correct expected state returns the row");
    assert.equal(won.currentState, "OUTREACH_SENT");
    assert.ok(
      won.updatedAt.getTime() >= instance!.updatedAt.getTime(),
      "$onUpdate restamped updatedAt",
    );
  });

  await test("loser: stale expected state matches 0 rows → null, no throw", async () => {
    // A concurrent worker also read the instance at ENROLLED and lost the
    // race — its conditional update must be a no-op, not an exception.
    const lost = await updateInstanceStateConditional(
      instance!.id,
      "ENROLLED",
      { currentState: "FOLLOWED_UP", followUpCount: 99 },
      pgdb,
    );
    assert.equal(lost, null, "lose-the-race path returns null");

    const [row] = await pgdb
      .select()
      .from(schema.executionInstances)
      .where(eq(schema.executionInstances.id, instance!.id));
    assert.equal(row!.currentState, "OUTREACH_SENT", "loser wrote nothing");
    assert.equal(row!.followUpCount, 0, "loser's patch fields were not applied");
  });

  await test("unknown instance id → null, no throw", async () => {
    const missing = await updateInstanceStateConditional(
      "nonexistent-instance-id",
      "ENROLLED",
      { currentState: "OUTREACH_SENT" },
      pgdb,
    );
    assert.equal(missing, null);
  });

  await test("next legitimate transition still works after a lost race", async () => {
    const advanced = await updateInstanceStateConditional(
      instance!.id,
      "OUTREACH_SENT",
      { currentState: "AWAITING_REPLY", dueAt: new Date("2026-07-20T00:00:00Z") },
      pgdb,
    );
    assert.ok(advanced);
    assert.equal(advanced.currentState, "AWAITING_REPLY");
    assert.equal(advanced.dueAt?.toISOString(), "2026-07-20T00:00:00.000Z");
  });

  await pg.close();
  console.log(`\n${n} passed\n`);
}

await main();
