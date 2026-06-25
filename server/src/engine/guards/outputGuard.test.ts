/**
 * Unit tests for the outbound output guard (FIX-4).
 * Pure function — run with:  npx tsx src/engine/guards/outputGuard.test.ts
 */

import assert from "node:assert/strict";
import { scanOutboundDraft, guardConstraintsFromConfig } from "./outputGuard.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\noutputGuard.scanOutboundDraft\n");

const C = { floor: 500, ceiling: 2000 };

test("clean draft passes", () => {
  const r = scanOutboundDraft(
    { subject: "Partnership", body: "We'd love to work with you on this campaign." },
    C,
  );
  assert.equal(r.ok, true);
});

test("blocks when floor number leaks (bare)", () => {
  const r = scanOutboundDraft({ body: "Our minimum is 500 for this." }, C);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.hits[0]!.kind, "floor");
});

test("blocks when ceiling leaks with $ and comma", () => {
  const r = scanOutboundDraft({ body: "We can go up to $2,000 max." }, C);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.hits.some((h) => h.kind === "ceiling"));
});

test("blocks ceiling written plainly as 2000", () => {
  const r = scanOutboundDraft({ body: "absolute max 2000 dollars" }, C);
  assert.equal(r.ok, false);
});

test("does NOT match a bound as a substring of a larger number", () => {
  // 500 must not match inside 2500; 2000 must not match inside 12000.
  const r = scanOutboundDraft({ body: "How about 2500? Or even 12000 views." }, C);
  assert.equal(r.ok, true);
});

test("allowlisted rate equal to a bound is not blocked", () => {
  // We intentionally present 500 this turn → not a leak.
  const r = scanOutboundDraft({ body: "Our offer is $500." }, { ...C, allowedRate: 500 });
  assert.equal(r.ok, true);
});

test("a different number than the allowlisted one still blocks", () => {
  const r = scanOutboundDraft({ body: "Offer $600, but our max is 2000." }, { ...C, allowedRate: 600 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.hits.some((h) => h.kind === "ceiling"));
});

test("scans subject too", () => {
  const r = scanOutboundDraft({ subject: "Re: 500 floor", body: "clean body" }, C);
  assert.equal(r.ok, false);
});

test("flags configured internal terms case-insensitively", () => {
  const r = scanOutboundDraft(
    { body: "This is our INTERNAL MAX, do not share." },
    { internalTerms: ["internal max"] },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.hits[0]!.kind, "term");
});

test("matches floor with decimals (500.00)", () => {
  const r = scanOutboundDraft({ body: "exactly 500.00 please" }, C);
  assert.equal(r.ok, false);
});

test("no constraints → always ok", () => {
  const r = scanOutboundDraft({ body: "anything 500 2000 goes" }, {});
  assert.equal(r.ok, true);
});

console.log("\nguardConstraintsFromConfig\n");

test("extracts floor/ceiling rates from node config", () => {
  const c = guardConstraintsFromConfig({
    termFloor: { rate: 500 },
    termCeiling: { rate: 2000 },
  });
  assert.equal(c.floor, 500);
  assert.equal(c.ceiling, 2000);
});

test("threads allowedRate and internalTerms", () => {
  const c = guardConstraintsFromConfig(
    { termFloor: { rate: 100 }, internalTerms: ["budget cap", 42] },
    250,
  );
  assert.equal(c.allowedRate, 250);
  assert.deepEqual(c.internalTerms, ["budget cap"]); // non-strings filtered
});

test("missing terms yield undefined bounds (no false block)", () => {
  const c = guardConstraintsFromConfig({});
  assert.equal(c.floor, undefined);
  assert.equal(c.ceiling, undefined);
  const r = scanOutboundDraft({ body: "500 2000" }, c);
  assert.equal(r.ok, true);
});

console.log(`\n✓ outputGuard: all ${n} tests passed\n`);
