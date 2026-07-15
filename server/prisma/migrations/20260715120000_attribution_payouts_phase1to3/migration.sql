-- Attribution & Payouts — catch-up migration (Phases 1, 2, and 3).
--
-- Phases 1 and 2 applied their DDL directly to the live Neon database and
-- hand-authored server/src/db/schema.ts, but never added a Prisma migration
-- file (see repo history: commits 37d40fd, 28306ca). The migration-replay path
-- (PGlite-backed *.test.ts) therefore had no Partnership / Click / Conversion
-- tables. Phase 3 adds the payout ledger, whose Obligation/Payout tables have a
-- foreign key to Partnership — so this single migration catches the replay path
-- up to schema.ts by creating the Phase 1, Phase 2, AND Phase 3 objects in one
-- ordered file. It is byte-consistent with what the live Neon DB already has.
--
-- Constraint names follow the Prisma convention (Table_pkey / Table_col_fkey /
-- Table_col_idx) used by every other table in this database, so a later
-- `drizzle-kit pull` sees the same names it always has.

-- ── Phase 1 — Partnership & referral link ───────────────────────────────────

-- CreateEnum
CREATE TYPE "PartnershipStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'PARTNERSHIP_ACTIVATED';

-- AlterTable (Campaign gains the referral-target columns)
ALTER TABLE "Campaign" ADD COLUMN "targetUrl" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "hiddenParamKey" TEXT NOT NULL DEFAULT '_from';

-- CreateTable
CREATE TABLE "Partnership" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "campaignId" TEXT,
    "creatorId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "trackingLink" TEXT,
    "commissionRate" REAL,
    "agreedFeeCents" INTEGER,
    "status" "PartnershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partnership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Partnership_instanceId_key" ON "Partnership"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "Partnership_referralCode_key" ON "Partnership"("referralCode");

-- CreateIndex
CREATE INDEX "Partnership_campaignId_idx" ON "Partnership"("campaignId");

-- CreateIndex
CREATE INDEX "Partnership_creatorId_idx" ON "Partnership"("creatorId");

-- AddForeignKey
ALTER TABLE "Partnership" ADD CONSTRAINT "Partnership_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Partnership" ADD CONSTRAINT "Partnership_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Partnership" ADD CONSTRAINT "Partnership_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Phase 2 — Attribution (Click + Conversion) ──────────────────────────────

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'CONVERSION_RECORDED';
ALTER TYPE "EventType" ADD VALUE 'CONVERSION_REFUNDED';

-- CreateTable
CREATE TABLE "Click" (
    "id" TEXT NOT NULL,
    "partnershipId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "referer" TEXT,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Click_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Click_partnershipId_idx" ON "Click"("partnershipId");

-- CreateIndex
CREATE INDEX "Click_clickedAt_idx" ON "Click"("clickedAt");

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_partnershipId_fkey" FOREIGN KEY ("partnershipId") REFERENCES "Partnership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "Conversion" (
    "id" TEXT NOT NULL,
    "partnershipId" TEXT,
    "referralCode" TEXT,
    "externalId" TEXT NOT NULL,
    "valueCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "commissionCents" INTEGER NOT NULL DEFAULT 0,
    "customerEmail" TEXT,
    "metadata" JSONB,
    "payoutId" TEXT,
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversion_externalId_key" ON "Conversion"("externalId");

-- CreateIndex
CREATE INDEX "Conversion_partnershipId_idx" ON "Conversion"("partnershipId");

-- CreateIndex
CREATE INDEX "Conversion_payoutId_idx" ON "Conversion"("payoutId");

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_partnershipId_fkey" FOREIGN KEY ("partnershipId") REFERENCES "Partnership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Phase 3 — Payout ledger (Obligation + Payout) ───────────────────────────

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'DISPUTED', 'SETTLED');

-- CreateEnum
CREATE TYPE "PayoutType" AS ENUM ('COMMISSION', 'FIXED_FEE');

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'PAYOUT_CREATED';
ALTER TYPE "EventType" ADD VALUE 'PAYOUT_SENT';
ALTER TYPE "EventType" ADD VALUE 'PAYOUT_CONFIRMED';
ALTER TYPE "EventType" ADD VALUE 'PAYOUT_DISPUTED';
ALTER TYPE "EventType" ADD VALUE 'PAYOUT_SETTLED';

-- CreateTable
CREATE TABLE "Obligation" (
    "id" TEXT NOT NULL,
    "partnershipId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING',
    "payoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Obligation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Obligation_partnershipId_idx" ON "Obligation"("partnershipId");

-- AddForeignKey
ALTER TABLE "Obligation" ADD CONSTRAINT "Obligation_partnershipId_fkey" FOREIGN KEY ("partnershipId") REFERENCES "Partnership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "partnershipId" TEXT NOT NULL,
    "payoutType" "PayoutType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "method" "PayoutMethod",
    "destination" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "conversionCount" INTEGER NOT NULL DEFAULT 0,
    "confirmTokenHash" TEXT,
    "confirmTokenExpiresAt" TIMESTAMP(3),
    "confirmIp" TEXT,
    "confirmUserAgent" TEXT,
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "disputedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payout_partnershipId_idx" ON "Payout"("partnershipId");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_partnershipId_fkey" FOREIGN KEY ("partnershipId") REFERENCES "Partnership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
