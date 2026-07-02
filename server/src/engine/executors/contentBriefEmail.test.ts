/**
 * Unit tests for the Content Brief "Your Campaign Brief" email renderer. Pure —
 * no DB, no network, no file system. Run:
 *   npx tsx src/engine/executors/contentBriefEmail.test.ts
 */

import assert from "node:assert/strict";
import { renderContentBriefEmail } from "./contentBriefEmail.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\ncontentBriefEmail\n");

const full = () =>
  renderContentBriefEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    referralLink: "https://example.com/referral/creator123",
    creatorNotes: "Please tag @pluvus in your first story.",
  });

// ── Subject ──────────────────────────────────────────────────────────────────
test("subject is exactly 'Your Campaign Brief'", () => {
  assert.equal(full().subject, "Your Campaign Brief");
});

// ── Body — required copy ─────────────────────────────────────────────────────
test("body greets the creator and welcomes them aboard", () => {
  const { body } = full();
  assert.match(body, /^Hi Ada,/);
  assert.match(body, /Welcome aboard!/);
});

test("body references the attached brief and asks the creator to review it", () => {
  const { body } = full();
  assert.match(body, /Attached is your campaign brief/);
  assert.match(body, /Please review the attached document carefully/);
});

test("body signs off as the brand", () => {
  const { body } = full();
  assert.match(body, /Thanks,\nPluvus$/);
});

// ── Referral link ────────────────────────────────────────────────────────────
test("body includes the referral link verbatim under a label when configured", () => {
  const { body } = full();
  assert.match(body, /Your referral link:/);
  assert.ok(body.includes("https://example.com/referral/creator123"));
});

test("body omits the referral section entirely when no link is configured", () => {
  const { body } = renderContentBriefEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    referralLink: "",
    creatorNotes: "",
  });
  assert.doesNotMatch(body, /Your referral link:/);
});

// ── Creator notes ────────────────────────────────────────────────────────────
test("body includes the creator notes verbatim when provided", () => {
  const { body } = full();
  assert.ok(body.includes("Please tag @pluvus in your first story."));
});

test("body omits notes cleanly when none are provided (no empty gap markers)", () => {
  const { body } = renderContentBriefEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    referralLink: "https://x.test/r/1",
    creatorNotes: "   ",
  });
  // The paragraph after the referral link should be the review reminder, with no
  // stray blank paragraph where the notes would have been.
  assert.doesNotMatch(body, /\n\n\n/);
  assert.match(body, /Please review the attached document/);
});

// ── Product/sample reward ────────────────────────────────────────────────────
test("body mentions the reward when a rewardDescription is provided", () => {
  const { body } = renderContentBriefEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    referralLink: "",
    creatorNotes: "",
    rewardDescription: "a free pair of our running shoes",
  });
  assert.match(body, /you'll receive a free pair of our running shoes\./);
});

test("body omits the reward sentence when no reward is configured", () => {
  // full() is built without a rewardDescription.
  assert.doesNotMatch(full().body, /you'll receive/);
});

// ── No attachment bytes here (that's the executor's job) ─────────────────────
test("renderer returns only subject + body (attachment is added by the executor)", () => {
  const draft = full();
  assert.deepEqual(Object.keys(draft).sort(), ["body", "subject"]);
});

console.log(`\n${n} passed\n`);
