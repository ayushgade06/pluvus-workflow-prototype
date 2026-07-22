-- Randomized Send Delay (§4.4): poison-loop bound for the poller safety-net
-- sweep. A reserved-but-unsent OUTBOUND Message row (externalMessageId IS NULL)
-- whose delayed-send job was lost from Redis is reclaimed by the sweep; without a
-- bound, a row whose flush PERMANENTLY fails (bad recipient, revoked grant) would
-- be re-enqueued every poll forever. `redriveCount` caps that: the sweep claims a
-- row only while redriveCount < SEND_DELAY_MAX_REDRIVES, then abandons it for
-- manual inspection.
--
-- Purely ADDITIVE. One new column, NOT NULL DEFAULT 0, so every existing Message
-- (inbound + already-sent outbound) is backfilled to 0 — the "never swept" value.
-- NOT NULL + DEFAULT means Postgres does this as a fast metadata-only change (no
-- full table rewrite).
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden against the
-- live Neon schema — see drizzle.config.ts). Idempotent: ADD COLUMN IF NOT EXISTS
-- so a partial prior run does not fail a re-run.

-- AlterTable
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "redriveCount" INTEGER NOT NULL DEFAULT 0;
