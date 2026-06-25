-- FIX-11: outbound AI-send idempotency.
-- Additive, backward-compatible: new nullable column; all existing rows get NULL,
-- and NULLs are exempt from the unique constraint in PostgreSQL.

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_idempotencyKey_key" ON "Message"("idempotencyKey");
