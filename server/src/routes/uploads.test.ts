/**
 * Unit tests for the /uploads content validation (MED-S3). Pure — no Express, no
 * multer, no disk. Verifies the %PDF- magic-byte check that stops a non-PDF file
 * (named ".pdf") from being stored and later emailed to creators as the brief.
 * Run:  npx tsx src/routes/uploads.test.ts
 */

import assert from "node:assert/strict";
import { hasPdfMagicBytes } from "./uploads.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nuploads.hasPdfMagicBytes (MED-S3)\n");

test("accepts a real PDF header (%PDF-1.7)", () => {
  const buf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj", "latin1");
  assert.equal(hasPdfMagicBytes(buf), true);
});

test("accepts the bare 5-byte signature", () => {
  assert.equal(hasPdfMagicBytes(Buffer.from("%PDF-", "latin1")), true);
});

test("rejects HTML disguised as a PDF", () => {
  const buf = Buffer.from("<!DOCTYPE html><html>gotcha</html>", "utf8");
  assert.equal(hasPdfMagicBytes(buf), false);
});

test("rejects a file with %PDF- NOT at offset 0", () => {
  // A leading junk byte before the header is not a valid PDF start.
  const buf = Buffer.from(" %PDF-1.4", "latin1");
  assert.equal(hasPdfMagicBytes(buf), false);
});

test("rejects an empty buffer", () => {
  assert.equal(hasPdfMagicBytes(Buffer.alloc(0)), false);
});

test("rejects a too-short buffer that only partially matches", () => {
  assert.equal(hasPdfMagicBytes(Buffer.from("%PD", "latin1")), false);
});

test("rejects a similar-but-wrong signature", () => {
  assert.equal(hasPdfMagicBytes(Buffer.from("%PDX-1.7", "latin1")), false);
});

console.log(`\n${n} passed\n`);
