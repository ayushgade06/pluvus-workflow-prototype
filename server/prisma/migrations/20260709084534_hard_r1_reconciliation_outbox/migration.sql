-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "OutboxJob" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "OutboxJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboxJob_dedupeKey_key" ON "OutboxJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxJob_status_createdAt_idx" ON "OutboxJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxJob_instanceId_idx" ON "OutboxJob"("instanceId");

-- CreateIndex
CREATE INDEX "ExecutionInstance_currentState_dueAt_idx" ON "ExecutionInstance"("currentState", "dueAt");

-- AddForeignKey
ALTER TABLE "OutboxJob" ADD CONSTRAINT "OutboxJob_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
