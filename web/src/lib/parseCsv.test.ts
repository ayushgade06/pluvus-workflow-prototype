/**
 * Unit tests for the client-side CSV parser (parseCsv).
 * Pure logic, no DOM — runnable with the repo-root tsx:
 *   npx tsx web/src/lib/parseCsv.test.ts
 */

import assert from "node:assert/strict";
import { parseCsv } from "./parseCsv.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function main() {
  console.log("\nparseCsv\n");

  test("basic header + rows map to known fields", () => {
    const { rows, missingEmailColumn } = parseCsv(
      "email,name,handle\na@x.com,Ada,ada\nb@x.com,Bob,bob\n",
    );
    assert.equal(missingEmailColumn, false);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { email: "a@x.com", name: "Ada", handle: "ada" });
    assert.deepEqual(rows[1], { email: "b@x.com", name: "Bob", handle: "bob" });
  });

  test("headers are matched case- and space-insensitively", () => {
    const { rows, missingEmailColumn } = parseCsv(
      "E-Mail, Full Name ,Platform\na@x.com,Ada Lovelace,Instagram\n",
    );
    assert.equal(missingEmailColumn, false);
    assert.deepEqual(rows[0], {
      email: "a@x.com",
      name: "Ada Lovelace",
      platform: "Instagram",
    });
  });

  test("quoted field with a comma is one cell", () => {
    const { rows } = parseCsv('email,name\na@x.com,"Doe, Jane"\n');
    assert.equal(rows[0]!.name, "Doe, Jane");
  });

  test("escaped double-quotes inside a quoted field", () => {
    const { rows } = parseCsv('email,name\na@x.com,"She said ""hi"""\n');
    assert.equal(rows[0]!.name, 'She said "hi"');
  });

  test("newline inside a quoted field stays in the cell", () => {
    const { rows } = parseCsv('email,name\na@x.com,"line1\nline2"\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "line1\nline2");
  });

  test("CRLF line endings are handled", () => {
    const { rows } = parseCsv("email,name\r\na@x.com,Ada\r\nb@x.com,Bob\r\n");
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.email, "b@x.com");
  });

  test("leading BOM is stripped from the first header", () => {
    const { rows, missingEmailColumn } = parseCsv("﻿email,name\na@x.com,Ada\n");
    assert.equal(missingEmailColumn, false);
    assert.equal(rows[0]!.email, "a@x.com");
  });

  test("unknown columns are folded into metadata under original header", () => {
    const { rows } = parseCsv("email,Followers,Region\na@x.com,10k,EU\n");
    assert.deepEqual(rows[0]!.metadata, { Followers: "10k", Region: "EU" });
  });

  test("missing email column is flagged", () => {
    const { missingEmailColumn } = parseCsv("name,handle\nAda,ada\n");
    assert.equal(missingEmailColumn, true);
  });

  test("blank lines are skipped", () => {
    const { rows } = parseCsv("email,name\n\na@x.com,Ada\n\n\nb@x.com,Bob\n");
    assert.equal(rows.length, 2);
  });

  test("file not ending in a newline still yields the last row", () => {
    const { rows } = parseCsv("email,name\na@x.com,Ada");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "Ada");
  });

  test("empty text yields no rows and flags missing email", () => {
    const { rows, missingEmailColumn } = parseCsv("");
    assert.equal(rows.length, 0);
    assert.equal(missingEmailColumn, true);
  });

  test("a row missing its email cell comes back with email empty", () => {
    const { rows } = parseCsv("email,name\n,Ada\n");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.email, "");
    assert.equal(rows[0]!.name, "Ada");
  });

  console.log(`\n${n} passed\n`);
}

main();
