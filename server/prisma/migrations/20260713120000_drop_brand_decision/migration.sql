-- V1 founder-alignment (Phase A / #14): remove the brand-decision loop.
-- Escalation is now a clean one-way handoff to a human — there is no
-- AWAITING_BRAND_DECISION waiting state and no BrandDecision round-trip table.
--
-- Ordering matters: move any live rows OFF the enum value BEFORE the enum is
-- recreated without it (Postgres cannot drop an in-use enum value), and drop the
-- FK table BEFORE the InstanceState type it does not depend on (independent, but
-- kept explicit).

-- Data migration (Q1): move any instance still parked in AWAITING_BRAND_DECISION
-- to the terminal MANUAL_REVIEW handoff. No-op on a DB with none, but required so
-- the enum recreation below can never fail on an in-use value.
UPDATE "ExecutionInstance"
SET "currentState" = 'MANUAL_REVIEW',
    "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "currentState" = 'AWAITING_BRAND_DECISION';

-- DropForeignKey
ALTER TABLE "BrandDecision" DROP CONSTRAINT "BrandDecision_instanceId_fkey";

-- DropTable (its indexes are dropped with it)
DROP TABLE "BrandDecision";

-- DropEnum
DROP TYPE "BrandDecisionStatus";

-- AlterEnum: recreate InstanceState without AWAITING_BRAND_DECISION.
-- Postgres has no ALTER TYPE ... DROP VALUE, so swap in a new type: create the
-- new enum, repoint the column (default dropped first, restored after), then drop
-- the old type.
BEGIN;
CREATE TYPE "InstanceState_new" AS ENUM ('ENROLLED', 'OUTREACH_SENT', 'AWAITING_REPLY', 'FOLLOWED_UP', 'REPLY_RECEIVED', 'NEGOTIATING', 'ACCEPTED', 'REWARD_PENDING', 'REWARD_CONFIRMED', 'PAYMENT_PENDING', 'PAYMENT_RECEIVED', 'CONTENT_BRIEF_SENT', 'REJECTED', 'OPTED_OUT', 'NO_RESPONSE', 'MANUAL_REVIEW');
ALTER TABLE "ExecutionInstance" ALTER COLUMN "currentState" DROP DEFAULT;
ALTER TABLE "ExecutionInstance" ALTER COLUMN "currentState" TYPE "InstanceState_new" USING ("currentState"::text::"InstanceState_new");
ALTER TABLE "ExecutionInstance" ALTER COLUMN "currentState" SET DEFAULT 'ENROLLED';
ALTER TYPE "InstanceState" RENAME TO "InstanceState_old";
ALTER TYPE "InstanceState_new" RENAME TO "InstanceState";
DROP TYPE "InstanceState_old";
COMMIT;
