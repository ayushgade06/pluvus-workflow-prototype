-- CreateEnum
CREATE TYPE "BrandDecisionStatus" AS ENUM ('PENDING', 'RESOLVED', 'REASKED', 'HANDED_OFF', 'EXPIRED');

-- AlterEnum
ALTER TYPE "InstanceState" ADD VALUE 'AWAITING_BRAND_DECISION';

-- CreateTable
CREATE TABLE "BrandDecision" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "BrandDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "contextJson" JSONB NOT NULL,
    "brandReplyRaw" TEXT,
    "decision" TEXT,
    "decisionValue" DOUBLE PRECISION,
    "reaskCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "BrandDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandDecision_token_key" ON "BrandDecision"("token");

-- CreateIndex
CREATE INDEX "BrandDecision_instanceId_idx" ON "BrandDecision"("instanceId");

-- AddForeignKey
ALTER TABLE "BrandDecision" ADD CONSTRAINT "BrandDecision_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
