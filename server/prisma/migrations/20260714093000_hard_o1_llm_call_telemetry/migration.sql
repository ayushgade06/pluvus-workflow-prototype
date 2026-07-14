-- HARD-O1 (observability): durable per-call LLM telemetry. One row per LLM
-- call the agent service made — token counts, latency, estimated cost, model +
-- prompt version — attributed to the workflow instance whose step made it.
-- Replaces the agent's in-process ring buffer as the queryable source of truth
-- (the buffer dies on restart and cannot attribute calls to an instance).
--
-- instanceId is NULLABLE: calls made outside an instance step (harnesses,
-- ad-hoc API use) still count toward totals. Token columns are nullable so a
-- provider that reports no usage_metadata stays "unreported", distinct from 0.
--
-- Constraint names follow the Prisma convention (Table_pkey / Table_col_fkey /
-- Table_col_idx) used by every other table in this database.

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT,
    "role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT,
    "latencyMs" DOUBLE PRECISION NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "estCostUsd" DOUBLE PRECISION,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errorKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmCall_instanceId_idx" ON "LlmCall"("instanceId");

-- CreateIndex
CREATE INDEX "LlmCall_createdAt_idx" ON "LlmCall"("createdAt");

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
