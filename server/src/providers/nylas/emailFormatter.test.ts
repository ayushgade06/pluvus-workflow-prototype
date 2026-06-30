/**
 * Unit tests for the outbound email formatter (presentation only).
 * Run with:  npx tsx src/providers/nylas/emailFormatter.test.ts
 *
 * The contract under test: plainTextToHtmlEmail wraps a plain-text body in
 * clean business-email HTML WITHOUT changing any wording — only whitespace and
 * markup change.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { plainTextToHtmlEmail } from "./emailFormatter.js";

// Strip all tags + decode the handful of entities we emit, to recover the
// visible text. <br> and block tags become spaces (a line break reads as
// whitespace), so this recovers wording independent of whitespace/markup.
// Used to assert wording is byte-for-byte preserved aside from whitespace.
function visibleText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

test("separates greeting, body, and closing into paragraphs", () => {
  const body = [
    "Hello Alex,",
    "",
    "We are thrilled to welcome you to the MuscleBlaze family!",
    "",
    "Best regards,",
    "MuscleBlaze",
  ].join("\n");

  const html = plainTextToHtmlEmail(body);

  // Greeting and welcome each become their own <p>.
  assert.match(html, /<p[^>]*>Hello Alex,<\/p>/);
  assert.match(html, /<p[^>]*>We are thrilled to welcome you to the MuscleBlaze family!<\/p>/);
  // Closing block keeps its internal line break (name under sign-off).
  assert.match(html, /Best regards,<br>MuscleBlaze/);
});

test("does not change the wording (text is byte-for-byte preserved)", () => {
  const body = [
    "Hi Jordan,",
    "",
    "We are pleased to confirm the agreed rate of $450 per post.",
    "",
    "Once signed, let's schedule a quick call.",
    "",
    "Best,",
    "Pluvus",
  ].join("\n");

  // visibleText already normalizes whitespace; compare the source the same way.
  const text = visibleText(plainTextToHtmlEmail(body));
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  assert.equal(text, collapse(body));
});

test("renders **bold** markers as <strong>", () => {
  const body = "We confirm the agreed rate of **$450 per post**.";
  const html = plainTextToHtmlEmail(body);
  assert.match(html, /<strong>\$450 per post<\/strong>/);
  // The literal asterisks are gone from the visible text.
  assert.doesNotMatch(visibleText(html), /\*\*/);
});

test("preserves bullet lists", () => {
  const body = [
    "Deliverables:",
    "",
    "- One Instagram post",
    "- Two stories",
    "- One reel",
  ].join("\n");

  const html = plainTextToHtmlEmail(body);
  assert.match(html, /<ul[^>]*>/);
  assert.match(html, /<li>One Instagram post<\/li>/);
  assert.match(html, /<li>Two stories<\/li>/);
  assert.match(html, /<li>One reel<\/li>/);
});

test("preserves numbered lists", () => {
  const body = [
    "Next steps:",
    "",
    "1. Sign the agreement",
    "2. Schedule a call",
    "3. Begin content",
  ].join("\n");

  const html = plainTextToHtmlEmail(body);
  assert.match(html, /<ol[^>]*>/);
  assert.match(html, /<li>Sign the agreement<\/li>/);
  assert.match(html, /<li>Begin content<\/li>/);
});

test("linkifies bare URLs while keeping the displayed text identical", () => {
  const body = "Please sign here: https://pluvus.com/sign?id=abc&x=1";
  const html = plainTextToHtmlEmail(body);
  assert.match(html, /<a href="https:\/\/pluvus\.com\/sign\?id=abc&amp;x=1">/);
  // Visible link text equals the original URL.
  assert.match(visibleText(html), /https:\/\/pluvus\.com\/sign\?id=abc&x=1/);
});

test("escapes HTML-significant characters in the copy", () => {
  const body = "Rate < ceiling & terms > floor for \"premium\" tier.";
  const html = plainTextToHtmlEmail(body);
  assert.match(html, /&lt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&gt;/);
  assert.match(html, /&quot;/);
  // Round-trips back to the exact original.
  assert.equal(visibleText(html), body);
});

test("is idempotent — already-HTML bodies pass through untouched", () => {
  const html = "<div><p>Already HTML</p></div>";
  assert.equal(plainTextToHtmlEmail(html), html);
});

test("returns empty / falsy bodies unchanged", () => {
  assert.equal(plainTextToHtmlEmail(""), "");
});

test("wraps output in a single styled container", () => {
  const html = plainTextToHtmlEmail("Hello.");
  assert.match(html, /^<div style="font-family:/);
  assert.match(html, /<\/div>$/);
});
