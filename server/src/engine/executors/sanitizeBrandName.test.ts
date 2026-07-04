/**
 * Unit tests for sanitizeBrandName (L4 config-fix). Pure — turns a brand's
 * free-text reply into a usable brand name, or "" when there's nothing usable
 * (which makes the caller re-ask rather than write garbage into every email).
 *
 * Run with:  npx tsx src/engine/executors/sanitizeBrandName.test.ts
 */

import assert from "node:assert/strict";
import { sanitizeBrandName } from "./brandDecision.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nsanitizeBrandName (L4 config-fix)\n");

test("bare name passes through", () => {
  assert.equal(sanitizeBrandName("Acme Co."), "Acme Co");
});

test("strips a leading 'it's'", () => {
  assert.equal(sanitizeBrandName("It's Acme Athletics"), "Acme Athletics");
});

test("strips a leading 'the brand is'", () => {
  assert.equal(sanitizeBrandName("The brand name is Nimbus Running"), "Nimbus Running");
});

test("drops a trailing sign-off on the same line", () => {
  assert.equal(sanitizeBrandName("Acme Athletics. Thanks!"), "Acme Athletics");
  assert.equal(sanitizeBrandName("Nimbus, cheers"), "Nimbus");
  assert.equal(sanitizeBrandName("Peak Gear — regards, Sam"), "Peak Gear —"); // em-dash kept; sign-off dropped
});

test("takes the first non-empty line, ignoring a following signature block", () => {
  assert.equal(sanitizeBrandName("Acme Co\n\nSam Rivera\nBrand Manager"), "Acme Co");
});

test("empty / whitespace-only reply yields empty string", () => {
  assert.equal(sanitizeBrandName(""), "");
  assert.equal(sanitizeBrandName("   \n  \n"), "");
});

test("caps absurdly long input at 80 chars", () => {
  const long = "X".repeat(200);
  assert.equal(sanitizeBrandName(long).length, 80);
});

console.log(`\n${n} passed\n`);
