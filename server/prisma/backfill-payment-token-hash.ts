// BUG-S1 one-shot data backfill — hash existing PLAINTEXT PaymentInfo tokens.
//
//   npx tsx prisma/backfill-payment-token-hash.ts            # apply
//   npx tsx prisma/backfill-payment-token-hash.ts --dry-run  # count, touch nothing
//
// Why a script, not a migration: the natural SQL (`UPDATE ... digest(token,
// 'sha256')`) needs the pgcrypto extension, which the PGlite migration-replay
// path (db/*.db.test.ts) does not bundle — so a pgcrypto migration would break
// the test suite. Hashing in Node (same sha256 hex the app uses) needs no
// extension and runs anywhere DATABASE_URL points.
//
// Idempotent: a sha256 hex is exactly 64 lowercase hex chars, so a row whose
// token already looks hashed is skipped. Safe to re-run. After the code deploy
// (which stores + looks up the HASH), run this ONCE against the live DB so any
// already-issued payout links keep resolving; rows minted post-deploy are
// already hashed and skipped. If no live pending links matter (dev/pre-pilot),
// running it is harmless — pre-existing plaintext links simply stop working,
// which is the secure outcome.
import { createHash } from "node:crypto";
import { pool } from "../src/db/drizzle.js";

const dryRun = process.argv.includes("--dry-run");
const HEX64 = /^[0-9a-f]{64}$/;

const client = await pool.connect();
try {
  const { rows } = await client.query<{ id: string; token: string }>(
    `SELECT "id", "token" FROM "PaymentInfo"`,
  );
  let hashed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (HEX64.test(r.token)) {
      skipped++;
      continue;
    }
    const tokenHash = createHash("sha256").update(r.token).digest("hex");
    if (!dryRun) {
      await client.query(`UPDATE "PaymentInfo" SET "token" = $1 WHERE "id" = $2`, [
        tokenHash,
        r.id,
      ]);
    }
    hashed++;
  }
  console.log(
    `${dryRun ? "DRY RUN — would hash" : "hashed"} ${hashed} plaintext token(s); ` +
      `skipped ${skipped} already-hashed; ${rows.length} total.`,
  );
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
  throw err;
} finally {
  client.release();
  await pool.end();
}
