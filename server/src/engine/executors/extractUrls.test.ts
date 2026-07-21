/**
 * Unit tests for deterministic content-URL extraction. Pure — no DB, no network.
 * Run:
 *   npx tsx src/engine/executors/extractUrls.test.ts
 */

import assert from "node:assert/strict";
import { extractContentUrls } from "./extractUrls.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nextractContentUrls\n");

test("extracts a single https URL", () => {
  assert.deepEqual(
    extractContentUrls("Here it is: https://instagram.com/p/abc123"),
    ["https://instagram.com/p/abc123"],
  );
});

test("extracts multiple URLs in first-seen order", () => {
  const text = "Reel: https://instagram.com/reel/1 and Story: https://tiktok.com/@me/video/2";
  assert.deepEqual(extractContentUrls(text), [
    "https://instagram.com/reel/1",
    "https://tiktok.com/@me/video/2",
  ]);
});

test("extracts http as well as https", () => {
  assert.deepEqual(extractContentUrls("old link http://example.com/x"), [
    "http://example.com/x",
  ]);
});

test("trims trailing sentence punctuation", () => {
  assert.deepEqual(extractContentUrls("See https://x.com/p/1."), ["https://x.com/p/1"]);
  assert.deepEqual(extractContentUrls("Is it https://x.com/p/1?"), ["https://x.com/p/1"]);
  assert.deepEqual(extractContentUrls("Links: https://x.com/p/1, https://x.com/p/2!"), [
    "https://x.com/p/1",
    "https://x.com/p/2",
  ]);
});

test("strips wrapping angle brackets and quotes", () => {
  assert.deepEqual(extractContentUrls("posted <https://x.com/p/1>"), ["https://x.com/p/1"]);
  assert.deepEqual(extractContentUrls('here: "https://x.com/p/1"'), ["https://x.com/p/1"]);
});

test("keeps a balanced trailing parenthesis but trims an unbalanced one", () => {
  assert.deepEqual(extractContentUrls("wiki https://en.wikipedia.org/wiki/Foo_(bar)"), [
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  ]);
  assert.deepEqual(extractContentUrls("(see https://x.com/p/1)"), ["https://x.com/p/1"]);
});

test("de-duplicates repeated URLs", () => {
  const text = "https://x.com/p/1 ... again https://x.com/p/1";
  assert.deepEqual(extractContentUrls(text), ["https://x.com/p/1"]);
});

test("returns [] when there are no URLs", () => {
  assert.deepEqual(extractContentUrls("it's live now, thanks!"), []);
  assert.deepEqual(extractContentUrls(""), []);
});

test("does NOT match a bare domain without a scheme (requires http/https)", () => {
  // We intentionally only capture links the creator deliberately pasted with a
  // scheme, to keep false positives low.
  assert.deepEqual(extractContentUrls("check instagram.com/p/abc"), []);
});

test("ignores a scheme-only fragment", () => {
  assert.deepEqual(extractContentUrls("https:// broken"), []);
});

test("captures a query string and fragment intact", () => {
  assert.deepEqual(
    extractContentUrls("https://youtube.com/watch?v=abc&t=10s#top done"),
    ["https://youtube.com/watch?v=abc&t=10s#top"],
  );
});

console.log(`\n${n} passed\n`);
