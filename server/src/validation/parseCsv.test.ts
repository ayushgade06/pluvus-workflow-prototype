/**
 * Unit tests for the delimited-text parser.
 * Moved from web/src/lib/parseCsv.test.ts when the parser became server-owned
 * (PLU-109), plus coverage for delimiter sniffing.
 * Run with:  npx tsx src/validation/parseCsv.test.ts
 */

import assert from "node:assert/strict";
import { parseDelimited, pickDelimiter, tokenize } from "./parseCsv.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function main() {
  console.log("\nparseCsv\n");

  test("basic header + rows become records keyed by header", () => {
    const { headers, records, rowCount } = parseDelimited(
      "email,name,handle\na@x.com,Ada,ada\nb@x.com,Bob,bob\n",
    );
    assert.deepEqual(headers, ["email", "name", "handle"]);
    assert.equal(rowCount, 2);
    assert.deepEqual(records[0], { email: "a@x.com", name: "Ada", handle: "ada" });
    assert.deepEqual(records[1], { email: "b@x.com", name: "Bob", handle: "bob" });
  });

  test("quoted field with a comma is one cell", () => {
    const { records } = parseDelimited('email,name\na@x.com,"Doe, Jane"\n');
    assert.equal(records[0]!["name"], "Doe, Jane");
  });

  test("escaped double-quotes inside a quoted field", () => {
    const { records } = parseDelimited('email,name\na@x.com,"She said ""hi"""\n');
    assert.equal(records[0]!["name"], 'She said "hi"');
  });

  test("newline inside a quoted field stays in the cell", () => {
    const { records } = parseDelimited('email,name\na@x.com,"line1\nline2"\n');
    assert.equal(records.length, 1);
    assert.equal(records[0]!["name"], "line1\nline2");
  });

  test("CRLF line endings are handled", () => {
    const { records } = parseDelimited("email,name\r\na@x.com,Ada\r\nb@x.com,Bob\r\n");
    assert.equal(records.length, 2);
    assert.equal(records[1]!["email"], "b@x.com");
  });

  test("leading BOM is stripped from the first header", () => {
    const { headers, records } = parseDelimited("﻿email,name\na@x.com,Ada\n");
    assert.deepEqual(headers, ["email", "name"]);
    assert.equal(records[0]!["email"], "a@x.com");
  });

  test("blank lines are skipped", () => {
    const { records } = parseDelimited("email,name\n\na@x.com,Ada\n\n\nb@x.com,Bob\n");
    assert.equal(records.length, 2);
  });

  test("file not ending in a newline still yields the last row", () => {
    const { records } = parseDelimited("email,name\na@x.com,Ada");
    assert.equal(records.length, 1);
    assert.equal(records[0]!["name"], "Ada");
  });

  test("empty text yields no headers and no rows", () => {
    const { headers, records, rowCount } = parseDelimited("");
    assert.equal(headers.length, 0);
    assert.equal(records.length, 0);
    assert.equal(rowCount, 0);
  });

  test("empty cells are omitted from the record entirely", () => {
    const { records } = parseDelimited("email,name\n,Ada\n");
    assert.equal("email" in records[0]!, false);
    assert.equal(records[0]!["name"], "Ada");
  });

  test("cells are trimmed", () => {
    const { records } = parseDelimited("email,name\n  a@x.com  ,  Ada  \n");
    assert.equal(records[0]!["email"], "a@x.com");
    assert.equal(records[0]!["name"], "Ada");
  });

  // --- delimiter sniffing --------------------------------------------------
  // The vendor export that motivated PLU-109 is TAB-separated despite a .csv
  // name. Hardcoding "," read the whole header as ONE column and rejected the
  // file for having no email column.

  test("comma is picked for a normal CSV", () => {
    assert.equal(pickDelimiter("email,name,handle\na,b,c"), ",");
  });

  test("tab is picked for a TSV", () => {
    assert.equal(pickDelimiter("email\tname\thandle\na\tb\tc"), "\t");
  });

  test("semicolon is picked for a European-style export", () => {
    assert.equal(pickDelimiter("email;name;handle\na;b;c"), ";");
  });

  test("a single-column file falls back to comma", () => {
    assert.equal(pickDelimiter("email\na@x.com"), ",");
  });

  test("tab-separated file parses end to end", () => {
    const { headers, records, delimiter } = parseDelimited(
      "email\tfull_name\tinstagram_username\na@x.com\tAda Lovelace\tada\n",
    );
    assert.equal(delimiter, "\t");
    assert.deepEqual(headers, ["email", "full_name", "instagram_username"]);
    assert.equal(records[0]!["full_name"], "Ada Lovelace");
  });

  test("a comma inside a TSV cell is NOT a delimiter", () => {
    const { records } = parseDelimited("email\tname\na@x.com\tDoe, Jane\n");
    assert.equal(records[0]!["name"], "Doe, Jane");
  });

  test("sniffing looks only at the header line, not the whole file", () => {
    // Body rows full of commas must not outvote the tab-delimited header.
    assert.equal(pickDelimiter("a\tb\nx,y,z,w,v,u\n"), "\t");
  });

  test("tokenize respects the delimiter it is given", () => {
    assert.deepEqual(tokenize("a;b;c", ";"), [["a", "b", "c"]]);
    assert.deepEqual(tokenize("a;b;c", ","), [["a;b;c"]]);
  });

  test("duplicate headers: last non-empty cell wins", () => {
    const { records } = parseDelimited("email,email\na@x.com,b@x.com\n");
    assert.equal(records[0]!["email"], "b@x.com");
  });

  console.log(`\n${n} passed\n`);
}

main();
