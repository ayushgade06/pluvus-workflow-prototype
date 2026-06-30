-- CreateEnum
CREATE TYPE "BrandNotificationStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'BRAND_NOTIFIED';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "notifyEmail" TEXT;

-- CreateTable
CREATE TABLE "BrandNotification" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "BrandNotificationStatus" NOT NULL DEFAULT 'SENT',
    "idempotencyKey" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandNotification_idempotencyKey_key" ON "BrandNotification"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BrandNotification_instanceId_idx" ON "BrandNotification"("instanceId");

-- AddForeignKey
ALTER TABLE "BrandNotification" ADD CONSTRAINT "BrandNotification_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
