/**
 * One-off enum migration: add the two content-links vocabulary values to the
 * live Postgres enums that the Prisma migrations own.
 *
 *   InstanceState  += 'CONTENT_LINKS_PENDING'
 *   EventType      += 'CONTENT_LINKS_SUBMITTED'
 *
 * The Drizzle schema is introspection-only (drizzle-kit pull) and the DB has no
 * _migrations_applied table, so new enum members are applied directly here — the
 * same way prior enum additions were rolled out to Neon. Idempotent: uses
 * ADD VALUE IF NOT EXISTS, so it is safe to run more than once and a no-op after
 * the first successful run.
 *
 * NB: ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so each
 * statement is issued on its own (the neon-serverless pool auto-commits).
 *
 * Run once after deploy, from server/:
 *   npx tsx scripts/add-content-links-enums.ts
 */

import { pool } from "../src/db/drizzle.js";

const STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    label: 'InstanceState += CONTENT_LINKS_PENDING',
    sql: `ALTER TYPE "InstanceState" ADD VALUE IF NOT EXISTS 'CONTENT_LINKS_PENDING'`,
  },
  {
    label: 'EventType += CONTENT_LINKS_SUBMITTED',
    sql: `ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'CONTENT_LINKS_SUBMITTED'`,
  },
];

async function main(): Promise<void> {
  console.log("\n[add-content-links-enums] applying enum values (idempotent)\n");
  for (const { label, sql } of STATEMENTS) {
    await pool.query(sql);
    console.log(`  ✓ ${label}`);
  }

  // Verify both members now exist.
  const { rows } = await pool.query<{ enumlabel: string; typname: string }>(
    `SELECT t.typname, e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE (t.typname = 'InstanceState' AND e.enumlabel = 'CONTENT_LINKS_PENDING')
         OR (t.typname = 'EventType'     AND e.enumlabel = 'CONTENT_LINKS_SUBMITTED')`,
  );
  const have = new Set(rows.map((r) => `${r.typname}.${r.enumlabel}`));
  const want = ["InstanceState.CONTENT_LINKS_PENDING", "EventType.CONTENT_LINKS_SUBMITTED"];
  const missing = want.filter((w) => !have.has(w));
  if (missing.length > 0) {
    throw new Error(`[add-content-links-enums] verification FAILED — missing: ${missing.join(", ")}`);
  }
  console.log("\n  ✓ verified both enum members exist\n");
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("[add-content-links-enums] error:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
