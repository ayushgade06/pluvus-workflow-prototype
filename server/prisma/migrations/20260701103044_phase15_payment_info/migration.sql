-- CreateEnum
CREATE TYPE "PaymentInfoStatus" AS ENUM ('PAYMENT_PENDING', 'PAYMENT_RECEIVED');

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('PAYPAL', 'WISE', 'BANK_TRANSFER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'PAYMENT_INFO_SENT';
ALTER TYPE "EventType" ADD VALUE 'PAYMENT_RECEIVED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InstanceState" ADD VALUE 'PAYMENT_PENDING';
ALTER TYPE "InstanceState" ADD VALUE 'PAYMENT_RECEIVED';

-- AlterEnum
ALTER TYPE "NodeType" ADD VALUE 'PAYMENT_INFO';

-- CreateTable
CREATE TABLE "PaymentInfo" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "PaymentInfoStatus" NOT NULL DEFAULT 'PAYMENT_PENDING',
    "method" "PayoutMethod",
    "accountIdentifier" TEXT,
    "country" TEXT,
    "notes" TEXT,
    "extra" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentInfo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentInfo_instanceId_key" ON "PaymentInfo"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentInfo_token_key" ON "PaymentInfo"("token");

-- CreateIndex
CREATE INDEX "PaymentInfo_instanceId_idx" ON "PaymentInfo"("instanceId");

-- AddForeignKey
ALTER TABLE "PaymentInfo" ADD CONSTRAINT "PaymentInfo_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
