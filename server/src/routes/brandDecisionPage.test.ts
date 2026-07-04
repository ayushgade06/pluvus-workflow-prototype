/**
 * Unit tests for the brand-decision confirmation pages (§2.5). Pure string
 * builders — no DB, no Express. Proves each action renders its own copy, that
 * the counter page reflects the amount, and that dynamic text is HTML-escaped.
 *
 * Run with:  npx tsx src/routes/brandDecisionPage.test.ts
 */

import assert from "node:assert/strict";
import {
  renderBrandDecisionResultPage,
  renderBrandDecisionAlreadyDonePage,
  renderBrandDecisionInvalidPage,
  renderBrandDecisionNeedsAmountPage,
} from "./brandDecisionPage.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const base = { brandName: "Acme", creatorName: "Robin" };

console.log("\nbrand-decision confirmation pages\n");

test("approve page names the creator and shows the approved state", () => {
  const html = renderBrandDecisionResultPage("approve", base);
  assert.match(html, /Approved/);
  assert.match(html, /Robin/);
  assert.match(html, /finalize the agreement/);
});

test("reject page reads as a pass", () => {
  const html = renderBrandDecisionResultPage("reject", base);
  assert.match(html, /Passed/);
  assert.match(html, /passed on Robin/);
});

test("counter page includes the amount when provided", () => {
  const html = renderBrandDecisionResultPage("counter", { ...base, amount: 350 });
  assert.match(html, /Counter recorded/);
  assert.match(html, /350/);
  assert.match(html, /take-it-or-leave-it/);
});

test("counter page omits a number gracefully when no amount", () => {
  const html = renderBrandDecisionResultPage("counter", base);
  assert.match(html, /Counter recorded/);
  assert.doesNotMatch(html, /undefined/);
});

test("handoff page routes to the manual queue", () => {
  const html = renderBrandDecisionResultPage("handoff", base);
  assert.match(html, /Handed to a human/);
  assert.match(html, /manual review queue/);
});

test("already-done page is idempotent copy, not an error", () => {
  const html = renderBrandDecisionAlreadyDonePage(base);
  assert.match(html, /Already decided/);
  assert.match(html, /Robin/);
});

test("invalid page explains an unknown/expired token", () => {
  const html = renderBrandDecisionInvalidPage();
  assert.match(html, /Link not found/);
  assert.match(html, /invalid or has expired/);
});

test("needs-amount page tells the brand how to counter", () => {
  const html = renderBrandDecisionNeedsAmountPage(base);
  assert.match(html, /Counter needs an amount/);
  assert.match(html, /COUNTER/);
});

test("dynamic text is HTML-escaped (no raw angle brackets from input)", () => {
  const html = renderBrandDecisionResultPage("approve", {
    brandName: "<script>",
    creatorName: "A&B",
  });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A&amp;B/);
  assert.doesNotMatch(html, /<script>/);
});

console.log(`\n${n} passed\n`);
