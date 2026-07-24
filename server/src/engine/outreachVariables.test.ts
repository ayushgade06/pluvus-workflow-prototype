/**
 * Unit tests for the shared outreach-variable module: template resolution,
 * unknown-token extraction, "did you mean" suggestions, and the mode-aware
 * config validator. Pure functions — no DB, no providers.
 *
 * Run with:  npx tsx src/engine/outreachVariables.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "../db/schema.js";
import {
  resolveOutreachTemplate,
  extractUnknownTokens,
  suggestVariable,
  validateOutreachConfig,
  OUTREACH_VARIABLE_NAMES,
} from "./outreachVariables.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const creator = {
  name: "Casey",
  platform: "TikTok",
  niche: "beauty",
} as unknown as Creator;

console.log("\noutreach variables\n");

// Drift guard: pin the canonical variable set. The web mirror
// (web/src/workflow/outreachVariables.ts) asserts the SAME list. If you
// add/rename a variable, update both modules AND both expected sets.
const EXPECTED_VARIABLE_NAMES = [
  "creatorName",
  "platform",
  "niche",
  "brandName",
  "senderName",
  "brandDescription",
  "rewardDescription",
  "deliverables",
  "timeline",
].sort();

test("allow-list matches the canonical variable set (web mirror contract)", () => {
  assert.deepEqual([...OUTREACH_VARIABLE_NAMES].sort(), EXPECTED_VARIABLE_NAMES);
});

test("resolves creator + brand + campaign variables", () => {
  const out = resolveOutreachTemplate(
    "Hi {{creatorName}} on {{platform}} ({{niche}}), from {{senderName}} at {{brandName}}. {{deliverables}} / {{timeline}} / {{rewardDescription}}",
    creator,
    {
      senderName: "Acme Partnerships",
      brandName: "Acme",
      deliverables: "2 Reels",
      timeline: "by Sept 15",
      rewardDescription: "free shoes",
    },
  );
  assert.equal(
    out,
    "Hi Casey on TikTok (beauty), from Acme Partnerships at Acme. 2 Reels / by Sept 15 / free shoes",
  );
});

test("brandName falls back to senderName when unset", () => {
  const out = resolveOutreachTemplate("{{brandName}}", creator, { senderName: "Solo Co" });
  assert.equal(out, "Solo Co");
});

test("senderName falls back to the default when unset", () => {
  const out = resolveOutreachTemplate("{{senderName}}", creator, {});
  assert.equal(out, "Pluvus Partnerships");
});

test("empty campaign fields resolve to empty string", () => {
  const out = resolveOutreachTemplate("[{{rewardDescription}}]", creator, {});
  assert.equal(out, "[]");
});

test("platform/niche fall back when absent on the creator", () => {
  const bare = { name: "Sky" } as unknown as Creator;
  const out = resolveOutreachTemplate("{{platform}}/{{niche}}", bare, {});
  assert.equal(out, "social media/your niche");
});

test("unknown token is stripped to empty (send-time net)", () => {
  const out = resolveOutreachTemplate("Hi {{creatorName}}{{firstName}}!", creator, {});
  assert.equal(out, "Hi Casey!");
});

test("whitespace inside braces is tolerated", () => {
  const out = resolveOutreachTemplate("Hi {{ creatorName }}", creator, {});
  assert.equal(out, "Hi Casey");
});

test("extractUnknownTokens returns only non-allow-listed names", () => {
  assert.deepEqual(extractUnknownTokens("{{creatorName}} {{firstName}} {{lastName}}"), [
    "firstName",
    "lastName",
  ]);
  assert.deepEqual(extractUnknownTokens("{{creatorName}} {{brandName}}"), []);
});

test("suggestVariable finds a spelling-close match", () => {
  assert.equal(suggestVariable("creatorname"), "creatorName"); // case-only diff
  assert.equal(suggestVariable("creatorNam"), "creatorName"); // one-char typo
  assert.equal(suggestVariable("branName"), "brandName"); // one-char deletion
  // A semantically-close but spelling-distant typo has no near match: the error
  // still rejects it, just without a suggestion.
  assert.equal(suggestVariable("firstName"), undefined);
  assert.equal(suggestVariable("zzzzzzzzzzz"), undefined);
});

test("every allow-listed name resolves to a non-token output", () => {
  for (const name of OUTREACH_VARIABLE_NAMES) {
    const out = resolveOutreachTemplate(`{{${name}}}`, creator, { brandName: "B", senderName: "S" });
    assert.ok(!out.includes("{{"), `${name} left an unresolved token`);
  }
});

// --- validation ---

test("manual mode requires subject", () => {
  const issue = validateOutreachConfig({ outreachMode: "manual", subjectTemplate: "", bodyTemplate: "hi" });
  assert.equal(issue?.code, "MISSING_SUBJECT");
});

test("manual mode requires body", () => {
  const issue = validateOutreachConfig({ outreachMode: "manual", subjectTemplate: "s", bodyTemplate: "  " });
  assert.equal(issue?.code, "MISSING_BODY");
});

test("manual mode with valid copy passes", () => {
  const issue = validateOutreachConfig({
    outreachMode: "manual",
    subjectTemplate: "Hi from {{brandName}}",
    bodyTemplate: "Hi {{creatorName}}",
  });
  assert.equal(issue, null);
});

test("unknown variable is rejected with a suggestion (spelling-close typo)", () => {
  const issue = validateOutreachConfig({
    outreachMode: "manual",
    subjectTemplate: "s",
    bodyTemplate: "Hi {{creatorNam}}",
  });
  assert.equal(issue?.code, "UNKNOWN_VARIABLE");
  assert.match(issue!.message, /did you mean \{\{creatorName\}\}/);
});

test("unknown variable with no near match is still rejected (no suggestion)", () => {
  const issue = validateOutreachConfig({
    outreachMode: "manual",
    subjectTemplate: "s",
    bodyTemplate: "Hi {{firstName}}",
  });
  assert.equal(issue?.code, "UNKNOWN_VARIABLE");
  assert.match(issue!.message, /not a known variable/);
});

test("ai/absent mode does not require subject/body", () => {
  assert.equal(validateOutreachConfig({ outreachMode: "ai", subjectTemplate: "", bodyTemplate: "" }), null);
  assert.equal(validateOutreachConfig({ subjectTemplate: "", bodyTemplate: "" }), null);
});

test("ai mode still rejects an unknown variable in the fallback", () => {
  const issue = validateOutreachConfig({
    outreachMode: "ai",
    subjectTemplate: "s",
    bodyTemplate: "{{bogusVar}}",
  });
  assert.equal(issue?.code, "UNKNOWN_VARIABLE");
});

console.log(`\n✓ outreachVariables: all ${n} tests passed\n`);
