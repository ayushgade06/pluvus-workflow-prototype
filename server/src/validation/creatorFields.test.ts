/**
 * Unit tests for creator field mapping (PLU-109).
 * Run with:  npx tsx src/validation/creatorFields.test.ts
 */

import assert from "node:assert/strict";
import {
  hasEmailColumn,
  mapCreatorRow,
  parseBool,
  parseCount,
  parsePercent,
} from "./creatorFields.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function main() {
  console.log("\ncreatorFields\n");

  // --- value coercion -------------------------------------------------------

  test("parseCount handles suffixes, separators, and plain integers", () => {
    assert.equal(parseCount("120k"), 120_000);
    assert.equal(parseCount("120K"), 120_000);
    assert.equal(parseCount("1.2M"), 1_200_000);
    assert.equal(parseCount("1,200"), 1200);
    assert.equal(parseCount("54000"), 54_000);
    assert.equal(parseCount("2.5k"), 2500);
  });

  test("parseCount returns null — NOT 0 — for blank/unparseable input", () => {
    // This is the difference between "unknown audience" sorting last and
    // masquerading as a creator with zero followers.
    assert.equal(parseCount(""), null);
    assert.equal(parseCount(undefined), null);
    assert.equal(parseCount("n/a"), null);
    assert.equal(parseCount("about 10k"), null);
  });

  test("parseCount preserves a real zero", () => {
    assert.equal(parseCount("0"), 0);
  });

  test("parsePercent strips a trailing %", () => {
    assert.equal(parsePercent("4.2%"), 4.2);
    assert.equal(parsePercent("4.2"), 4.2);
    assert.equal(parsePercent(""), null);
    assert.equal(parsePercent("high"), null);
  });

  test("parseBool accepts the common truthy/falsy spellings", () => {
    assert.equal(parseBool("true"), true);
    assert.equal(parseBool("Yes"), true);
    assert.equal(parseBool("1"), true);
    assert.equal(parseBool("false"), false);
    assert.equal(parseBool("NO"), false);
    assert.equal(parseBool("0"), false);
    assert.equal(parseBool("maybe"), null);
    assert.equal(parseBool(undefined), null);
  });

  // --- header aliasing ------------------------------------------------------

  test("every email alias is recognised", () => {
    for (const h of ["email", "Email", "E-Mail", "email_address", "Email Address", "mail"]) {
      assert.equal(hasEmailColumn([h]), true, `expected ${h} to be an email column`);
    }
    assert.equal(hasEmailColumn(["name", "handle"]), false);
  });

  test("headers match case-, space-, underscore- and hyphen-insensitively", () => {
    const row = mapCreatorRow({ "E-Mail": "a@x.com", " Full Name ": "Ada Lovelace", Platform: "Instagram" });
    assert.equal(row.email, "a@x.com");
    assert.equal(row.name, "Ada Lovelace");
    assert.equal(row.platform, "Instagram");
  });

  test("column order is irrelevant", () => {
    const a = mapCreatorRow({ email: "a@x.com", name: "Ada" });
    const b = mapCreatorRow({ name: "Ada", email: "a@x.com" });
    assert.deepEqual(a, b);
  });

  test("full_name beats first_name when both are present", () => {
    const row = mapCreatorRow({ email: "a@x.com", first_name: "Ada", full_name: "Ada Lovelace" });
    assert.equal(row.name, "Ada Lovelace");
  });

  test("first_name is used when full_name is absent", () => {
    const row = mapCreatorRow({ email: "a@x.com", first_name: "Ada" });
    assert.equal(row.name, "Ada");
  });

  test("a leading @ is stripped from handles", () => {
    assert.equal(mapCreatorRow({ email: "a@x.com", handle: "@ada" }).handle, "ada");
  });

  test("unrecognised columns are preserved verbatim in metadata", () => {
    const row = mapCreatorRow({ email: "a@x.com", Rate: "$500", "Internal Notes": "warm" });
    assert.deepEqual(row.metadata, { Rate: "$500", "Internal Notes": "warm" });
  });

  // A hand-made list writes a bare "Followers" column with no network prefix.
  // Without this, such a file imports with an EMPTY followerCount and the
  // picker's default sort key is blank for every row.
  test("a generic Followers column populates followerCount", () => {
    const row = mapCreatorRow({ email: "a@x.com", Followers: "120k" });
    assert.equal(row.followerCount, 120_000);
    assert.equal(row.metadata, null);
  });

  test("generic follower aliases are all recognised", () => {
    for (const h of ["followers", "follower_count", "Subscribers", "audience", "reach"]) {
      const row = mapCreatorRow({ email: "a@x.com", [h]: "5k" });
      assert.equal(row.followerCount, 5000, `expected ${h} to map to followerCount`);
    }
  });

  test("a generic engagement column populates engagementRate", () => {
    assert.equal(mapCreatorRow({ email: "a@x.com", engagement_rate: "3.5%" }).engagementRate, 3.5);
  });

  test("an explicit Followers column wins over the per-network maximum", () => {
    const row = mapCreatorRow({
      email: "a@x.com",
      Followers: "1M",
      tiktok_follower_count: "900k",
    });
    assert.equal(row.followerCount, 1_000_000);
  });

  test("per-network counts still win when there is no generic column", () => {
    const row = mapCreatorRow({ email: "a@x.com", tiktok_follower_count: "900k" });
    assert.equal(row.followerCount, 900_000);
  });

  test("a generic column does not collide with the per-network ones", () => {
    // "instagram_follower_count" must not normalize onto "followercount".
    const row = mapCreatorRow({ email: "a@x.com", instagram_follower_count: "50k" });
    assert.equal(row.followerCount, 50_000);
    assert.equal(row.platformStats!["instagram"]!.followers, 50_000);
  });

  test("'Region' is treated as a location, not dropped into metadata", () => {
    const row = mapCreatorRow({ email: "a@x.com", Region: "EU" });
    assert.equal(row.location, "EU");
    assert.equal(row.metadata, null);
  });

  test("a recognised column never leaks into metadata", () => {
    const row = mapCreatorRow({ email: "a@x.com", instagram_follower_count: "500" });
    assert.equal(row.metadata, null);
  });

  // --- vendor export: primary-network derivation ----------------------------

  test("platform/handle/profileUrl/engagement all come from the LARGEST network", () => {
    const row = mapCreatorRow({
      email: "a@x.com",
      instagram_username: "ada_ig",
      instagram_link: "https://instagram.com/ada_ig",
      instagram_follower_count: "50k",
      instagram_engagement_percent: "2.1",
      tiktok_username: "ada_tt",
      tiktok_link: "https://tiktok.com/@ada_tt",
      tiktok_follower_count: "900k",
      tiktok_engagement_percent: "4.2",
      youtube_custom_url: "@adayt",
      youtube_link: "https://youtube.com/@adayt",
      youtube_subscriber_count: "12k",
    });
    assert.equal(row.platform, "TikTok");
    assert.equal(row.handle, "ada_tt");
    assert.equal(row.profileUrl, "https://tiktok.com/@ada_tt");
    assert.equal(row.engagementRate, 4.2);
    // followerCount is the MAX across networks — a creator's reach is their
    // biggest audience, and this is the picker's default sort key.
    assert.equal(row.followerCount, 900_000);
  });

  test("all three networks are kept in platformStats", () => {
    const row = mapCreatorRow({
      email: "a@x.com",
      instagram_follower_count: "50k",
      instagram_avg_likes: "1200",
      tiktok_follower_count: "900k",
      youtube_subscriber_count: "12k",
    });
    assert.equal(row.platformStats!["instagram"]!.followers, 50_000);
    assert.equal(row.platformStats!["instagram"]!.avgLikes, 1200);
    assert.equal(row.platformStats!["tiktok"]!.followers, 900_000);
    assert.equal(row.platformStats!["youtube"]!.followers, 12_000);
  });

  test("an explicit platform column wins over derivation", () => {
    const row = mapCreatorRow({
      email: "a@x.com",
      platform: "Instagram",
      tiktok_follower_count: "900k",
    });
    assert.equal(row.platform, "Instagram");
  });

  test("a link-only network still yields a platform", () => {
    // No follower counts anywhere, but an instagram_link exists — the creator
    // should still be "Instagram", not blank.
    const row = mapCreatorRow({ email: "a@x.com", instagram_link: "https://instagram.com/ada" });
    assert.equal(row.platform, "Instagram");
    assert.equal(row.profileUrl, "https://instagram.com/ada");
  });

  test("no network data at all leaves derived fields null", () => {
    const row = mapCreatorRow({ email: "a@x.com" });
    assert.equal(row.platform, null);
    assert.equal(row.handle, null);
    assert.equal(row.followerCount, null);
    assert.equal(row.platformStats, null);
  });

  // --- niche derivation -----------------------------------------------------
  // The outreach prompt interpolates {niche} and otherwise says "content
  // creation" for everyone. The vendor export has no niche column.

  test("niche falls back through topic_details → hashtags → type_of_profile", () => {
    assert.equal(
      mapCreatorRow({ email: "a@x.com", youtube_topic_details: "Fitness" }).niche,
      "Fitness",
    );
    assert.equal(
      mapCreatorRow({ email: "a@x.com", hashtags_used: "#gym #protein" }).niche,
      "#gym #protein",
    );
    assert.equal(
      mapCreatorRow({ email: "a@x.com", type_of_profile: "Influencer" }).niche,
      "Influencer",
    );
  });

  test("niche fallback respects priority order", () => {
    const row = mapCreatorRow({
      email: "a@x.com",
      youtube_topic_details: "Fitness",
      hashtags_used: "#gym",
      type_of_profile: "Influencer",
    });
    assert.equal(row.niche, "Fitness");
  });

  test("an explicit niche column wins over every fallback", () => {
    const row = mapCreatorRow({
      email: "a@x.com",
      niche: "Cooking",
      youtube_topic_details: "Fitness",
    });
    assert.equal(row.niche, "Cooking");
  });

  // --- bio, links, signals --------------------------------------------------

  test("bio prefers personal_intro, else the primary network's biography", () => {
    assert.equal(
      mapCreatorRow({ email: "a@x.com", personal_intro: "Hi, I'm Ada." }).bio,
      "Hi, I'm Ada.",
    );
    const derived = mapCreatorRow({
      email: "a@x.com",
      tiktok_follower_count: "900k",
      tiktok_biography: "dancing + code",
      instagram_follower_count: "1k",
      instagram_biography: "photos",
    });
    assert.equal(derived.bio, "dancing + code");
  });

  test("socialLinks collects every network plus patreon/onlyfans/external", () => {
    const row = mapCreatorRow({
      email: "a@x.com",
      instagram_link: "https://instagram.com/ada",
      tiktok_link: "https://tiktok.com/@ada",
      patreon_link: "https://patreon.com/ada",
      onlyfans_link: "https://onlyfans.com/ada",
      external_urls: "https://ada.dev",
    });
    assert.deepEqual(row.socialLinks, {
      instagram: "https://instagram.com/ada",
      tiktok: "https://tiktok.com/@ada",
      patreon: "https://patreon.com/ada",
      onlyfans: "https://onlyfans.com/ada",
      externalUrls: "https://ada.dev",
    });
  });

  test("qualification signals are typed, not left as strings", () => {
    const row = mapCreatorRow({
      email: "a@x.com",
      has_brand_deals: "true",
      promotes_affiliate_links: "yes",
      has_merch: "no",
      type_of_profile: "Influencer",
      instagram_income_min: "1.2k",
    });
    assert.equal(row.signals!["has_brand_deals"], true);
    assert.equal(row.signals!["promotes_affiliate_links"], true);
    assert.equal(row.signals!["has_merch"], false);
    assert.equal(row.signals!["type_of_profile"], "Influencer");
    assert.equal(row.signals!["instagram_income_min"], 1200);
  });

  test("location and language map straight through", () => {
    const row = mapCreatorRow({ email: "a@x.com", location: "Berlin", language: "de" });
    assert.equal(row.location, "Berlin");
    assert.equal(row.language, "de");
  });

  test("profile_picture_url does NOT collide with the profileUrl alias", () => {
    // "profilepictureurl" must not normalize onto "profileurl".
    const row = mapCreatorRow({ email: "a@x.com", profile_picture_url: "https://img/1.jpg" });
    assert.equal(row.profileUrl, null);
    assert.deepEqual(row.metadata, { profile_picture_url: "https://img/1.jpg" });
  });

  test("youtube_description does NOT collide with the bio 'description' alias", () => {
    const row = mapCreatorRow({ email: "a@x.com", youtube_description: "my channel" });
    // It is the youtube bio, reachable only when YouTube is the primary network.
    assert.equal(row.metadata, null);
  });

  console.log(`\n${n} passed\n`);
}

main();
