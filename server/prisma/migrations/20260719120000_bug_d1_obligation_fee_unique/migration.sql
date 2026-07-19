-- BUG-D1 (CRITICAL, live-verified): no unique constraint on the auto-minted fee
-- Obligation. `mintFeeObligation` (executors/partnership.ts) does a check-then-
-- insert with no DB backstop and no surrounding transaction, so two concurrent
-- resolvePartnership paths (a BullMQ retry racing the reconciliation sweep) can
-- both read zero obligations and both INSERT — the brand then pays the agreed
-- collaboration fee TWICE. The live pg_index query showed only "Obligation_pkey"
-- + the non-unique "Obligation_partnershipId_idx".
--
-- Fix: a PARTIAL unique index over (partnershipId) restricted to the auto-minted
-- fee row (identified by its fixed description, FEE_OBLIGATION_DESCRIPTION =
-- 'Agreed collaboration fee'). Partial — not a plain unique on partnershipId —
-- so a partnership can still carry additional MANUAL/extra obligations later
-- (Phase-4+ future work) without the DB rejecting them; only the ONE auto-minted
-- fee obligation is constrained to be unique per partnership. This is exactly the
-- invariant mintFeeObligation already tries to enforce in application code
-- (existing.length > 0 → no-op), now enforced by the database so a concurrent
-- race cannot slip a second row past the check.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden on this
-- schema — schema.ts:11-15). Constraint name follows the Prisma convention so a
-- later `drizzle-kit pull` sees the name it expects.
--
-- Safe to apply to the live DB: the live integrity snapshot showed
-- ">1 obligation per partnership: NONE", so no existing row violates this.

-- CreateIndex
CREATE UNIQUE INDEX "Obligation_partnershipId_fee_key"
  ON "Obligation" ("partnershipId")
  WHERE ("description" = 'Agreed collaboration fee');
