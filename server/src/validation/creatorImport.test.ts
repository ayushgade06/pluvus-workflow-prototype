/**
 * Unit tests for import row preparation (PLU-109).
 * Replaces the old routes/creators.test.ts, which tested validateImportRows —
 * removed when the JSON import endpoint was superseded by the multipart,
 * two-phase batch flow.
 * Run with:  npx tsx src/validation/creatorImport.test.ts
 */

import assert from "node:assert/strict";
import { prepareRows } from "./creatorImport.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function main() {
  console.log("\ncreatorImport.prepareRows\n");

  test("a valid row produces an insert and no error", () => {
    const [row] = prepareRows([
      { email: "a@x.com", name: "Ada", handle: "ada", platform: "IG", niche: "tech" },
    ]);
    assert.equal(row!.errorReason, null);
    assert.equal(row!.insert!.email, "a@x.com");
    assert.equal(row!.insert!.name, "Ada");
    assert.equal(row!.insert!.handle, "ada");
  });

  test("missing email is reported with a 1-based row number", () => {
    const [row] = prepareRows([{ name: "No Email" }]);
    assert.equal(row!.insert, null);
    assert.equal(row!.rowNumber, 1);
    assert.equal(row!.errorReason, "missing email");
  });

  test("malformed email is reported as invalid", () => {
    const [row] = prepareRows([{ email: "not-an-email" }]);
    assert.equal(row!.insert, null);
    assert.match(row!.errorReason!, /invalid email/);
  });

  test("missing name falls back to the email local-part", () => {
    const [row] = prepareRows([{ email: "robin.banks@x.com" }]);
    assert.equal(row!.insert!.name, "robin.banks");
  });

  // --- the case-sensitivity defect this release fixes ------------------------
  // The DB unique index is on the raw TEXT column. Before PLU-109 the bulk path
  // deduped on a lowercased key in JS but INSERTED the original string, so
  // "Jane@x.com" arriving when "jane@x.com" existed missed the conflict branch
  // and created a second creator for the same person.

  test("emails are normalized to lowercase", () => {
    const [row] = prepareRows([{ email: "  Jane@X.COM  " }]);
    assert.equal(row!.insert!.email, "jane@x.com");
  });

  test("two casings of one address collapse to a single import", () => {
    const rows = prepareRows([{ email: "Jane@x.com" }, { email: "jane@X.com" }]);
    assert.equal(rows[0]!.insert!.email, "jane@x.com");
    assert.equal(rows[1]!.insert, null);
    assert.match(rows[1]!.errorReason!, /duplicate of row 1/);
  });

  // --- in-file duplicates ---------------------------------------------------

  test("a duplicate email names the row it duplicates", () => {
    const rows = prepareRows([
      { email: "a@x.com" },
      { email: "b@x.com" },
      { email: "a@x.com" },
    ]);
    assert.equal(rows[2]!.insert, null);
    assert.equal(rows[2]!.errorReason, "duplicate of row 1 (a@x.com)");
  });

  test("every row comes back, including skipped ones, so counts are explainable", () => {
    const rows = prepareRows([
      { email: "ok1@x.com" },
      { name: "bad — no email" },
      { email: "ok2@x.com" },
      { email: "@@@" },
    ]);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.filter((r) => r.insert).map((r) => r.insert!.email),
      ["ok1@x.com", "ok2@x.com"],
    );
    assert.deepEqual(
      rows.filter((r) => !r.insert).map((r) => r.rowNumber),
      [2, 4],
    );
  });

  test("the original cells are retained for later diagnosis", () => {
    const [row] = prepareRows([{ email: "a@x.com", Followers: "10k" }]);
    assert.deepEqual(row!.raw, { email: "a@x.com", Followers: "10k" });
  });

  // --- vendor export end to end ---------------------------------------------

  test("a vendor row derives platform/handle/audience into the insert", () => {
    const [row] = prepareRows([
      {
        email: "Ada@Example.com",
        full_name: "Ada Lovelace",
        location: "London",
        language: "en",
        personal_intro: "I build things.",
        tiktok_username: "ada_tt",
        tiktok_link: "https://tiktok.com/@ada_tt",
        tiktok_follower_count: "900k",
        tiktok_engagement_percent: "4.2%",
        instagram_follower_count: "50k",
        promotes_affiliate_links: "true",
        contact_phone_number: "+44 7700 900000",
      },
    ]);
    const insert = row!.insert!;
    assert.equal(insert.email, "ada@example.com");
    assert.equal(insert.name, "Ada Lovelace");
    assert.equal(insert.platform, "TikTok");
    assert.equal(insert.handle, "ada_tt");
    assert.equal(insert.profileUrl, "https://tiktok.com/@ada_tt");
    assert.equal(insert.followerCount, 900_000);
    assert.equal(insert.engagementRate, 4.2);
    assert.equal(insert.location, "London");
    assert.equal(insert.language, "en");
    assert.equal(insert.bio, "I build things.");
    // The phone number is stored (it is legitimate CRM data) but lands in the
    // generic metadata blob, which llmSafeCreatorContext never forwards.
    assert.deepEqual(insert.metadata, { contact_phone_number: "+44 7700 900000" });
  });

  console.log(`\n${n} passed\n`);
}

main();
