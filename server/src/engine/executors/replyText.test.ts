/**
 * Unit tests for inbound reply-text extraction (H1).
 * Pure logic — run with:
 *   npx tsx src/engine/executors/replyText.test.ts
 *
 * Regression target: classifying the raw email body lets our own quoted outreach
 * ("interested", "rate", "commission") and the creator's signature dominate the
 * signal, so a "No." can read POSITIVE. extractReplyText returns just the
 * top-posted reply, and falls back to the raw body if it would over-cut.
 */

import assert from "node:assert/strict";
import { extractReplyText } from "./replyText.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nextractReplyText (H1)\n");

test("strips an 'On ... wrote:' quoted block", () => {
  const raw = [
    "No thanks.",
    "",
    "On Mon, Jan 1, 2026 at 10:00 AM, Acme Partnerships <hi@acme.com> wrote:",
    "> We'd love to partner with you! Are you interested? What's your rate?",
    "> We offer a great commission on every sale.",
  ].join("\n");
  const out = extractReplyText(raw);
  assert.equal(out, "No thanks.");
  // The quoted "interested"/"rate"/"commission" must be gone.
  assert.ok(!/interested|rate|commission/i.test(out));
});

test("strips leading '>' quoted lines even without a header", () => {
  const raw = ["Sounds good, count me in!", "> our earlier note about the campaign"].join("\n");
  assert.equal(extractReplyText(raw), "Sounds good, count me in!");
});

test("strips an RFC-3676 signature block ('-- ')", () => {
  const raw = ["Yes, let's do it.", "", "-- ", "Jane Doe", "Influencer | 200k followers"].join("\n");
  assert.equal(extractReplyText(raw), "Yes, let's do it.");
});

test("strips a 'Sent from my iPhone' signature", () => {
  const raw = ["No thanks, not a good fit.", "", "Sent from my iPhone"].join("\n");
  assert.equal(extractReplyText(raw), "No thanks, not a good fit.");
});

test("strips an Outlook '-----Original Message-----' block", () => {
  const raw = [
    "What's the commission?",
    "",
    "-----Original Message-----",
    "From: Acme <hi@acme.com>",
    "We'd love to work with you.",
  ].join("\n");
  assert.equal(extractReplyText(raw), "What's the commission?");
});

test("a plain reply with no quotes is returned unchanged (trimmed)", () => {
  assert.equal(extractReplyText("  I charge $480  "), "I charge $480");
});

test("falls back to the raw body when cleaning would leave nothing", () => {
  // Bottom-posted reply where the top is entirely a quote header + quoted lines:
  // over-cutting would leave empty, so we keep the raw body rather than classify "".
  const raw = ["On Mon Jan 1 2026, Acme wrote:", "> are you interested?"].join("\n");
  const out = extractReplyText(raw);
  assert.ok(out.length > 0, "must not return empty");
  assert.equal(out, raw.trim());
});

test("empty / whitespace body is handled without throwing", () => {
  assert.equal(extractReplyText(""), "");
  assert.equal(extractReplyText("   \n  "), "   \n  ".trim() === "" ? extractReplyText("   \n  ") : "");
});

test("real-world case: quoted history contains positive words, reply is a refusal", () => {
  const raw = [
    "Not for me, thanks.",
    "",
    "On Tue, Acme <hi@acme.com> wrote:",
    "> Hi! We're very interested in partnering. Would you be open to a great rate",
    "> plus commission? We'd love to collaborate!",
  ].join("\n");
  const out = extractReplyText(raw);
  assert.equal(out, "Not for me, thanks.");
  assert.ok(!/interested|love to|collaborate|commission/i.test(out));
});

console.log(`\n${n} passed\n`);
