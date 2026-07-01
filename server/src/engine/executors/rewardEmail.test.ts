/**
 * Unit tests for the Reward Setup "Campaign Agreement Confirmation" email
 * renderer. Verifies bulleted terms, deliverables splitting (incl. "+"), the
 * optional timeline line, and the "I Agree" call-to-action. Pure. Run:
 *   npx tsx src/engine/executors/rewardEmail.test.ts
 */

import assert from "node:assert/strict";
import { renderRewardConfirmationEmail, splitDeliverables } from "./rewardEmail.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nrewardEmail\n");

// ── splitDeliverables ──────────────────────────────────────────────────────
test("splits on '+' so each deliverable is its own bullet", () => {
  assert.deepEqual(splitDeliverables("2 Instagram Reels + 1 Instagram Story"), [
    "2 Instagram Reels",
    "1 Instagram Story",
  ]);
});
test("splits on commas and newlines too", () => {
  assert.deepEqual(splitDeliverables("1 Reel, 2 Stories\n1 TikTok"), [
    "1 Reel",
    "2 Stories",
    "1 TikTok",
  ]);
});
test("single deliverable stays one bullet", () => {
  assert.deepEqual(splitDeliverables("1 YouTube integration"), ["1 YouTube integration"]);
});
test("empty / undefined → no items", () => {
  assert.deepEqual(splitDeliverables(""), []);
  assert.deepEqual(splitDeliverables(undefined), []);
});

// ── renderRewardConfirmationEmail ──────────────────────────────────────────
const full = renderRewardConfirmationEmail({
  creatorName: "Ayush Gade",
  brandName: "Pluvus",
  senderName: "Pluvus",
  fixedFee: 425,
  commissionRate: 10,
  deliverables: "2 Instagram Reels + 1 Instagram Story",
  timeline: "Content live by July 20, 2026",
});

test("subject is the fixed confirmation subject", () => {
  assert.equal(full.subject, "Campaign Agreement Confirmation");
});
test("shows the fixed fee, commission, and asks for 'I Agree'", () => {
  assert.match(full.body, /• Fixed Fee: \$425/);
  assert.match(full.body, /• Commission: 10%/);
  assert.match(full.body, /"I Agree"/);
});
test("deliverables render as separate bullets (split on '+')", () => {
  assert.match(full.body, /    - 2 Instagram Reels/);
  assert.match(full.body, /    - 1 Instagram Story/);
  // The raw "A + B" form must NOT appear on a single line.
  assert.doesNotMatch(full.body, /2 Instagram Reels \+ 1 Instagram Story/);
});
test("timeline line is included when present", () => {
  assert.match(full.body, /• Timeline: Content live by July 20, 2026/);
});

test("timeline line is omitted when absent", () => {
  const noTimeline = renderRewardConfirmationEmail({
    creatorName: "Dana",
    brandName: "Pluvus",
    senderName: "Pluvus",
    fixedFee: 300,
    commissionRate: 0,
    deliverables: "1 TikTok Post",
  });
  assert.doesNotMatch(noTimeline.body, /Timeline:/);
  // 0 commission renders as "None".
  assert.match(noTimeline.body, /• Commission: None/);
});

test("missing fee falls back to a safe phrase (never blank)", () => {
  const noFee = renderRewardConfirmationEmail({
    creatorName: "Dana",
    brandName: "Pluvus",
    senderName: "Pluvus",
    fixedFee: undefined,
    commissionRate: 15,
    deliverables: undefined,
  });
  assert.match(noFee.body, /• Fixed Fee: the agreed fee/);
  assert.match(noFee.body, /    - To be finalized/);
});

console.log(`\n${n} passed\n`);
