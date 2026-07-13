-- Phase D (#3): add the DEFERRED reply intent — the creator replied with no
-- clear commitment ("I'll think about it", "circle back next week"), which
-- schedules a soft follow-up rather than negotiating/rejecting/escalating.
--
-- A pure additive enum change: ALTER TYPE ... ADD VALUE. Appended last so the
-- physical order matches the schema (the other values are unchanged), and no
-- data migration is needed (no existing row can already hold DEFERRED).
ALTER TYPE "ReplyIntent" ADD VALUE 'DEFERRED';
