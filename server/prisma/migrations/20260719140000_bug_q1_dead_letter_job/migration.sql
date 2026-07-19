-- BUG-Q1 (CRITICAL) + BUG-Q2 (CRITICAL): dead-letter queue.
--
-- BullMQ jobs retry `attempts` (3) times; when the last attempt fails the job is
-- kept only in Redis under removeOnFail{count:100} — the 101st failure EVICTS the
-- oldest, and the on("failed") handler only console.error'd. So an exhausted job
-- (a lost creator reply, a stuck node step) died silently and invisibly, with no
-- durable record and no way to recover it.
--
-- This table is the durable dead-letter store. When a worker's on("failed")
-- handler sees a job that has EXHAUSTED its attempts, it writes a row here (the
-- full job payload + queue + error), so the job survives a Redis eviction/flush
-- and can be inspected and RE-DRIVEN. The inbound-email re-drive sweep (BUG-Q2)
-- reads PENDING rows for the inbound queue and re-enqueues them, so a failed
-- creator reply is recoverable instead of lost forever.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden). Constraint
-- names follow the Prisma convention so a later `drizzle-kit pull` sees the names
-- it expects. instanceId is a plain nullable TEXT (NO foreign key) on purpose: a
-- DLQ row must persist even if its instance is later deleted, and a dead job is
-- not always instance-scoped.

-- CreateEnum
CREATE TYPE "DeadLetterStatus" AS ENUM ('PENDING', 'REDRIVEN', 'DISCARDED');

-- CreateTable
CREATE TABLE "DeadLetterJob" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "jobId" TEXT,
    "jobName" TEXT,
    "payload" JSONB NOT NULL,
    "instanceId" TEXT,
    "failReason" TEXT,
    "attemptsMade" INTEGER NOT NULL DEFAULT 0,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'PENDING',
    "redriveCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redrivenAt" TIMESTAMP(3),

    CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The re-drive sweep scans by (queue, status) oldest-first.
CREATE INDEX "DeadLetterJob_queue_status_createdAt_idx" ON "DeadLetterJob" ("queue", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DeadLetterJob_instanceId_idx" ON "DeadLetterJob" ("instanceId");

-- CreateIndex
-- Idempotent dead-lettering: a given (queue, jobId) is recorded at most once even
-- if on("failed") fires more than once. jobId can be null (BullMQ auto-id jobs),
-- so this is a PARTIAL unique index over the rows that have one.
CREATE UNIQUE INDEX "DeadLetterJob_queue_jobId_key" ON "DeadLetterJob" ("queue", "jobId") WHERE ("jobId" IS NOT NULL);
