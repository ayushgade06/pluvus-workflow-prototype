/**
 * P8 — the test-data convention (isTestEmail) is what the harness-cleanup script
 * uses to decide which rows are safe to purge from a production DB. It deletes
 * EVERYTHING hanging off a matched creator, so the predicate must be strict: a
 * real creator's address must never match, and every known harness address must.
 * This locks both directions.
 *
 * Run: npx tsx --test src/config/testData.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isTestEmail, TEST_DATA_CONVENTION } from "./testData.js";

test("P8: reserved example/test domains are test data", () => {
  assert.equal(isTestEmail("phase8-harness-1@example.com"), true);
  assert.equal(isTestEmail("anyone@example.net"), true);
  assert.equal(isTestEmail("anyone@example.org"), true);
  assert.equal(isTestEmail("bob@foo.test"), true);
  assert.equal(isTestEmail("bob@localhost"), true);
});

test("P8: the named Nylas live-test creator is test data", () => {
  assert.equal(isTestEmail("ayushgade23@gmail.com"), true);
});

test("P8: local-part markers match on any domain", () => {
  assert.equal(isTestEmail("qa+harness@somedomain.com"), true);
  assert.equal(isTestEmail("phase8-harness-9@custom.io"), true);
  assert.equal(isTestEmail("harness-creator-2@custom.io"), true);
});

test("P8: matching is case-insensitive and trims whitespace", () => {
  assert.equal(isTestEmail("  Phase8-Harness-1@Example.com  "), true);
  assert.equal(isTestEmail("AYUSHGADE23@GMAIL.COM"), true);
});

test("P8: real creator addresses are NOT test data", () => {
  // The dangerous direction — a false positive here means deleting a paying
  // partner's ledger.
  assert.equal(isTestEmail("creator@youtube-star.com"), false);
  assert.equal(isTestEmail("jane.doe@gmail.com"), false);
  assert.equal(isTestEmail("partner@pluvus.com"), false);
  assert.equal(isTestEmail("hello@brand.co"), false);
  // "example" as a brand-name substring in the local part must NOT match — only
  // the reserved DOMAIN does.
  assert.equal(isTestEmail("example@realbrand.com"), false);
});

test("P8: empty / malformed input is never test data", () => {
  assert.equal(isTestEmail(null), false);
  assert.equal(isTestEmail(undefined), false);
  assert.equal(isTestEmail(""), false);
  assert.equal(isTestEmail("not-an-email"), false);
});

test("P8: the exported convention is non-empty (docs/diagnostics)", () => {
  assert.ok(TEST_DATA_CONVENTION.reservedDomains.includes("example.com"));
  assert.ok(TEST_DATA_CONVENTION.knownEmails.length >= 1);
});
