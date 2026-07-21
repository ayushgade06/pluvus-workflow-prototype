/**
 * Unit tests for the LLM-safe creator projection (PLU-109).
 *
 * This file exists to FAIL LOUDLY if someone widens what reaches a model
 * provider. The CSV import accepts creator-discovery vendor exports carrying a
 * phone number and adult-platform data for people who have not agreed to
 * anything with the brand — none of it should ever be sent to an LLM.
 *
 * Run with:  npx tsx src/validation/llmSafeCreator.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "../db/schema.js";
import { LLM_SAFE_CREATOR_FIELDS, llmSafeCreatorContext } from "./llmSafeCreator.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

/** A creator as a vendor export would leave them: enriched, and full of PII. */
function vendorCreator(): Creator {
  return {
    id: "c1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    handle: "ada_tt",
    niche: "Fitness",
    platform: "TikTok",
    bio: "I build things.",
    location: "London",
    language: "en",
    profileUrl: "https://tiktok.com/@ada_tt",
    followerCount: 900_000,
    engagementRate: 4.2,
    metadata: { contact_phone_number: "+44 7700 900000" },
    socialLinks: { onlyfans: "https://onlyfans.com/ada" },
    platformStats: { tiktok: { followers: 900_000 } },
    signals: { gender: "female", type_of_profile: "Influencer" },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Creator;
}

function main() {
  console.log("\nllmSafeCreator\n");

  test("the allowlist has exactly the expected members", () => {
    // Changing this list is a privacy decision. If this assertion fails, the
    // change is intentional — say so in review, do not just update the test.
    assert.deepEqual([...LLM_SAFE_CREATOR_FIELDS], [
      "name",
      "platform",
      "niche",
      "handle",
      "bio",
    ]);
  });

  test("only allowlisted fields survive the projection", () => {
    const safe = llmSafeCreatorContext(vendorCreator());
    assert.deepEqual(Object.keys(safe).sort(), ["bio", "handle", "name", "niche", "platform"]);
  });

  test("the phone number never appears anywhere in the payload", () => {
    const serialized = JSON.stringify(llmSafeCreatorContext(vendorCreator()));
    assert.equal(serialized.includes("7700"), false);
    assert.equal(serialized.includes("contact_phone_number"), false);
  });

  test("onlyfans data never appears anywhere in the payload", () => {
    const serialized = JSON.stringify(llmSafeCreatorContext(vendorCreator())).toLowerCase();
    assert.equal(serialized.includes("onlyfans"), false);
  });

  test("gender is never forwarded", () => {
    const serialized = JSON.stringify(llmSafeCreatorContext(vendorCreator())).toLowerCase();
    assert.equal(serialized.includes("gender"), false);
    assert.equal(serialized.includes("female"), false);
  });

  test("the email address is not forwarded — it is used to SEND, not to write", () => {
    const serialized = JSON.stringify(llmSafeCreatorContext(vendorCreator()));
    assert.equal(serialized.includes("ada@example.com"), false);
  });

  test("raw vendor blobs (metadata/signals/platformStats) are structurally excluded", () => {
    const safe = llmSafeCreatorContext(vendorCreator()) as Record<string, unknown>;
    for (const key of ["metadata", "signals", "platformStats", "socialLinks"]) {
      assert.equal(key in safe, false, `${key} must not reach an LLM`);
    }
  });

  test("blank and missing values are omitted rather than sent as empty strings", () => {
    const creator = { ...vendorCreator(), niche: "", bio: null } as unknown as Creator;
    const safe = llmSafeCreatorContext(creator);
    assert.equal("niche" in safe, false);
    assert.equal("bio" in safe, false);
  });

  console.log(`\n${n} passed\n`);
}

main();
