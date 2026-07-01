/**
 * Unit tests for the pure CSV-import validation helper (validateImportRows).
 * No DB, no Express — just the row-level validation contract.
 * Run with:  npx tsx src/routes/creators.test.ts
 */

import assert from "node:assert/strict";
import { validateImportRows } from "./creators.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function main() {
  console.log("\ncreators.validateImportRows\n");

  test("valid rows pass through with all fields", () => {
    const { valid, errors } = validateImportRows([
      { email: "a@x.com", name: "Ada", handle: "ada", platform: "IG", niche: "tech" },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(valid.length, 1);
    assert.deepEqual(valid[0], {
      email: "a@x.com",
      name: "Ada",
      handle: "ada",
      platform: "IG",
      niche: "tech",
    });
  });

  test("missing email is reported with a 1-based row number", () => {
    const { valid, errors } = validateImportRows([{ name: "No Email" }]);
    assert.equal(valid.length, 0);
    assert.deepEqual(errors, [{ row: 1, reason: "missing email" }]);
  });

  test("blank/whitespace email counts as missing", () => {
    const { errors } = validateImportRows([{ email: "   " }]);
    assert.deepEqual(errors, [{ row: 1, reason: "missing email" }]);
  });

  test("malformed email is reported as invalid", () => {
    const { valid, errors } = validateImportRows([{ email: "not-an-email" }]);
    assert.equal(valid.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.row, 1);
    assert.match(errors[0]!.reason, /invalid email/);
  });

  test("missing name falls back to the email local-part", () => {
    const { valid } = validateImportRows([{ email: "robin.banks@x.com" }]);
    assert.equal(valid[0]!.name, "robin.banks");
  });

  test("optional fields absent become null", () => {
    const { valid } = validateImportRows([{ email: "a@x.com", name: "Ada" }]);
    assert.equal(valid[0]!.handle, null);
    assert.equal(valid[0]!.platform, null);
    assert.equal(valid[0]!.niche, null);
  });

  test("metadata object is preserved; array/primitive is dropped", () => {
    const withObj = validateImportRows([
      { email: "a@x.com", metadata: { followers: "10k" } },
    ]);
    assert.deepEqual(withObj.valid[0]!.metadata, { followers: "10k" });

    const withArr = validateImportRows([{ email: "b@x.com", metadata: [1, 2] }]);
    assert.equal("metadata" in withArr.valid[0]!, false);
  });

  test("mixed batch: valid rows kept, bad rows reported in order", () => {
    const { valid, errors } = validateImportRows([
      { email: "ok1@x.com" },
      { name: "bad — no email" },
      { email: "ok2@x.com" },
      { email: "@@@" },
    ]);
    assert.deepEqual(valid.map((v) => v.email), ["ok1@x.com", "ok2@x.com"]);
    assert.deepEqual(
      errors.map((e) => e.row),
      [2, 4],
    );
  });

  test("whitespace around a valid email is trimmed", () => {
    const { valid } = validateImportRows([{ email: "  a@x.com  " }]);
    assert.equal(valid[0]!.email, "a@x.com");
  });

  console.log(`\n${n} passed\n`);
}

main();
