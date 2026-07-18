// Apply ALL migrations in order — the go-live path (see DEPLOYMENT.md §4).
//
//   npx tsx prisma/apply-all-migrations.ts            # apply every pending file
//   npx tsx prisma/apply-all-migrations.ts --dry-run  # list the plan, touch nothing
//
// Why this exists: there are 20+ migration dirs under prisma/migrations/, and the
// single-file runner (apply-migration.ts) wraps each file in ONE transaction. A file
// that contains `ALTER TYPE ... ADD VALUE` (enum growth) cannot always run inside a
// transaction. This runner handles that automatically:
//
//   • Files WITHOUT `ALTER TYPE ... ADD VALUE` → wrapped in BEGIN/COMMIT (atomic).
//   • Files WITH it → sent as a single un-wrapped query. node-postgres runs a
//     multi-statement string via the simple-query protocol WITHOUT an implicit
//     transaction, so `ALTER TYPE ... ADD VALUE` is permitted. (We deliberately do
//     NOT hand-split the SQL into statements — a naive splitter silently drops
//     lines; sending the whole file verbatim is both simpler and correct.)
//
// Idempotency: applied files are recorded in a _migrations_applied table; re-running
// skips them. DDL only — do not route JS Date params through this (see drizzle.ts).
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/drizzle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "migrations");
const dryRun = process.argv.includes("--dry-run");

// Migration dirs are named <timestamp>_<slug>; sorting the names sorts by time.
const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const client = await pool.connect();
try {
  if (!dryRun) {
    await client.query(
      `CREATE TABLE IF NOT EXISTS "_migrations_applied" (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
  }

  const appliedRes = dryRun
    ? { rows: [] as { name: string }[] }
    : await client.query<{ name: string }>(`SELECT name FROM "_migrations_applied"`);
  const applied = new Set(appliedRes.rows.map((r) => r.name));

  let count = 0;
  for (const name of dirs) {
    if (applied.has(name)) {
      console.log(`skip (already applied): ${name}`);
      continue;
    }
    const file = resolve(MIGRATIONS_DIR, name, "migration.sql");
    let sql: string;
    try {
      sql = readFileSync(file, "utf8");
    } catch {
      console.log(`skip (no migration.sql): ${name}`);
      continue;
    }

    // Run the file WITHOUT our own transaction wrapper when either:
    //  (a) it adds an enum value (ALTER TYPE ... ADD VALUE) — can't run in a txn, or
    //  (b) it manages its OWN transaction (contains a bare BEGIN) — wrapping it would
    //      nest/close transactions out of order.
    // In both cases node-postgres sends the file as one simple-query batch and lets
    // Postgres handle statement sequencing / the file's own BEGIN…COMMIT.
    const addsEnumValue = /ALTER\s+TYPE[\s\S]*?ADD\s+VALUE/i.test(sql);
    const managesOwnTxn = /^\s*BEGIN\s*;/im.test(sql);
    const needsAutocommit = addsEnumValue || managesOwnTxn;
    const mode = addsEnumValue
      ? "no-wrap (enum add)"
      : managesOwnTxn
        ? "no-wrap (self-managed txn)"
        : "transaction";
    console.log(`${dryRun ? "PLAN" : "apply"}: ${name}  [${mode}]`);
    if (dryRun) {
      count++;
      continue;
    }

    if (needsAutocommit) {
      // No wrapping transaction: node-postgres sends the whole file via the simple
      // query protocol. Enum-add files autocommit each statement; self-managed-txn
      // files run their own BEGIN…COMMIT. If such a file half-applies on error it is
      // NOT recorded as applied, so a fixed re-run resumes from it (may need manual
      // cleanup of the partially-applied statements first — rare, first-deploy only).
      await client.query(sql);
    } else {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
    await client.query(`INSERT INTO "_migrations_applied" (name) VALUES ($1)`, [name]);
    count++;
  }

  console.log(
    dryRun
      ? `\nDRY RUN — ${count} migration(s) would be applied (of ${dirs.length} total).`
      : `\nDone — ${count} migration(s) applied (of ${dirs.length} total).`,
  );
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
  throw err;
} finally {
  client.release();
  await pool.end();
}
