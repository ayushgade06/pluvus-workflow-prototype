-- PLU-109: CSV creator import — batch-scoped, auditable, built for long lists.
--
-- Two problems this solves:
--
-- 1. Every upload previously dissolved into one flat roster ("Creator", unique on
--    email, with no record of where a creator came from). Once yesterday's 200
--    creators and today's 150 were in the same list, there was no way to answer
--    "which are new", "which list did this person come from", or "enroll just
--    today's batch". CreatorImportBatch + CreatorImportBatchMember make each
--    upload a first-class, immutable record with a per-row audit trail.
--
-- 2. The roster carried no audience data, so picking 40 creators out of a 500-row
--    vendor export was blind. followerCount/engagementRate are promoted to real
--    columns because they are the picker's sort keys; the ~50 per-network metric
--    columns collapse into the platformStats JSONB block.
--
-- Creator is NOT restructured: email stays globally unique, so a creator
-- appearing in three uploads is still one row with three membership records.
-- All new Creator columns are nullable with no backfill, so this is safe on the
-- existing roster.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden — see
-- src/db/schema.ts). Constraint names follow the Prisma convention so a later
-- `drizzle-kit pull` sees the names it expects. Idempotent throughout: enums use
-- DO/EXCEPTION, tables/indexes/columns use IF NOT EXISTS, so a partial prior run
-- does not fail a re-run.

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "ImportBatchStatus" AS ENUM ('DRAFT', 'COMMITTED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
-- PENDING is the draft state: the row parsed and its email is valid, but nothing
-- has been written to Creator yet. Commit rewrites it to CREATED or UPDATED.
DO $$ BEGIN
  CREATE TYPE "ImportRowOutcome" AS ENUM ('PENDING', 'CREATED', 'UPDATED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable: promote the fields the picker sorts/filters by and the drafting
-- prompt interpolates. Everything else from a vendor export lands in the JSONB
-- columns below or in the pre-existing "metadata".
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "profileUrl" TEXT;
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "followerCount" INTEGER;
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "engagementRate" DOUBLE PRECISION;
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "location" TEXT;
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "language" TEXT;
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "bio" TEXT;
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "socialLinks" JSONB;
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "platformStats" JSONB;
ALTER TABLE "Creator" ADD COLUMN IF NOT EXISTS "signals" JSONB;

-- CreateIndex
-- The enroll picker's DEFAULT sort. NULLS LAST so "unknown audience" sorts to the
-- bottom rather than masquerading as the largest (Postgres defaults DESC to NULLS
-- FIRST, which would put every unknown creator at the top of the list).
CREATE INDEX IF NOT EXISTS "Creator_followerCount_idx" ON "Creator" ("followerCount" DESC NULLS LAST);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CreatorImportBatch" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    -- Opaque reference into the file-storage seam (src/storage/localFileStorage.ts),
    -- NOT a path. Nullable so a batch survives its file being purged.
    "fileReference" TEXT,
    "delimiter" TEXT,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "CreatorImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The source-list dropdown lists newest-first, filtered by status.
CREATE INDEX IF NOT EXISTS "CreatorImportBatch_status_createdAt_idx" ON "CreatorImportBatch" ("status", "createdAt");

-- CreateTable
CREATE TABLE IF NOT EXISTS "CreatorImportBatchMember" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    -- Nullable: a SKIPPED row (bad email, in-file duplicate) has no creator, but
    -- must still be recorded so the operator can see WHY it did not import.
    "creatorId" TEXT,
    "rowNumber" INTEGER NOT NULL,
    "outcome" "ImportRowOutcome" NOT NULL DEFAULT 'PENDING',
    "errorReason" TEXT,
    -- The original cells for this row, so a bad import is diagnosable and
    -- re-runnable months later even if the source file is gone.
    "rawRow" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorImportBatchMember_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
-- Deleting a batch discards its rows. It NEVER cascades to Creator: a creator may
-- be enrolled, partnered, or owed a payout, and their existence must not depend on
-- the upload that happened to introduce them.
DO $$ BEGIN
  ALTER TABLE "CreatorImportBatchMember"
    ADD CONSTRAINT "CreatorImportBatchMember_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "CreatorImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
-- ON DELETE SET NULL: if a creator is ever removed, the audit row survives with
-- its rawRow intact rather than vanishing from the batch's history.
DO $$ BEGIN
  ALTER TABLE "CreatorImportBatchMember"
    ADD CONSTRAINT "CreatorImportBatchMember_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateIndex
-- One member row per CSV row number, so re-running a commit cannot duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS "CreatorImportBatchMember_batchId_rowNumber_key" ON "CreatorImportBatchMember" ("batchId", "rowNumber");

-- CreateIndex
-- Listing a batch's members, and the outcome filter behind "select only the new ones".
CREATE INDEX IF NOT EXISTS "CreatorImportBatchMember_batchId_outcome_idx" ON "CreatorImportBatchMember" ("batchId", "outcome");

-- CreateIndex
-- Reverse lookup: "which lists did this creator come from" (the DUPLICATE badge).
CREATE INDEX IF NOT EXISTS "CreatorImportBatchMember_creatorId_idx" ON "CreatorImportBatchMember" ("creatorId");
