-- BUG-E1 (HIGH): ExecutionInstance had no version column, so optimistic
-- concurrency control (updateInstanceStateConditional) matched on currentState
-- ONLY. That guards a state CHANGE (X→Y: the loser sees Y and no-ops), but NOT a
-- self-transition (X→X: e.g. NEGOTIATING→NEGOTIATING, or a re-run that lands on
-- the same state). Two concurrent X→X writes both match `currentState = X` and
-- both commit → double event rows + double non-idempotent side effects.
--
-- Fix: a monotonic `version` counter. Every conditional write now predicates on
-- (currentState AND version) and SETs version = version + 1, so the FIRST writer
-- wins and bumps the version; the second matches the old version, updates 0 rows,
-- and cleanly no-ops (returns null) — even for X→X.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden). Default 0
-- backfills every existing row so no row is left NULL; NOT NULL + DEFAULT means
-- the ALTER is a fast metadata-only change on Postgres (no full table rewrite).

-- AlterTable
ALTER TABLE "ExecutionInstance" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
