/**
 * Unit tests for the WEB mirror of the outreach-variable module: the live
 * preview renderer, unknown-token extraction, and the mode-aware validator.
 * Must stay behaviorally identical to the server module.
 *
 * Run with:  npx tsx src/workflow/outreachVariables.test.ts
 */

import assert from "node:assert/strict";
import {
  renderOutreachPreview,
  extractUnknownTokens,
  validateOutreachConfig,
  PREVIEW_SAMPLE,
  OUTREACH_VARIABLE_NAMES,
} from "./outreachVariables";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("\noutreach variables (web mirror)\n");

// Drift guard: the web allow-list MUST match the server allow-list
// (server/src/engine/outreachVariables.ts). The two modules can't cross-import,
// so this frozen list is the contract. If you add/rename a variable, update BOTH
// modules AND this expected set — otherwise the palette resolves a variable the
// server would strip, or vice versa.
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

test("web allow-list matches the canonical variable set (server mirror contract)", () => {
  assert.deepEqual([...OUTREACH_VARIABLE_NAMES].sort(), EXPECTED_VARIABLE_NAMES);
});

test("preview resolves sample creator + config brand/campaign values", () => {
  const out = renderOutreachPreview(
    "Hi {{creatorName}} on {{platform}}, from {{brandName}}. {{rewardDescription}}",
    { brandName: "Acme", senderName: "Acme", rewardDescription: "free shoes" },
  );
  assert.equal(out, `Hi ${PREVIEW_SAMPLE.creatorName} on ${PREVIEW_SAMPLE.platform}, from Acme. free shoes`);
});

test("preview strips unknown tokens", () => {
  const out = renderOutreachPreview("Hi {{creatorName}}{{firstName}}", {});
  assert.equal(out, `Hi ${PREVIEW_SAMPLE.creatorName}`);
});

test("preview falls back senderName/brandName when unset", () => {
  assert.equal(renderOutreachPreview("{{senderName}}", {}), "Pluvus Partnerships");
  assert.equal(renderOutreachPreview("{{brandName}}", { senderName: "Solo" }), "Solo");
});

test("extractUnknownTokens flags typos", () => {
  assert.deepEqual(extractUnknownTokens("{{creatorName}} {{firstName}}"), ["firstName"]);
});

test("manual mode requires subject then body; reports the field", () => {
  const s = validateOutreachConfig({ outreachMode: "manual", subjectTemplate: "", bodyTemplate: "hi" });
  assert.equal(s?.code, "MISSING_SUBJECT");
  assert.equal(s?.field, "subject");
  const b = validateOutreachConfig({ outreachMode: "manual", subjectTemplate: "s", bodyTemplate: "" });
  assert.equal(b?.code, "MISSING_BODY");
  assert.equal(b?.field, "body");
});

test("unknown variable rejected with field placement", () => {
  const issue = validateOutreachConfig({
    outreachMode: "manual",
    subjectTemplate: "Hi {{bogus}}",
    bodyTemplate: "Hi {{creatorName}}",
  });
  assert.equal(issue?.code, "UNKNOWN_VARIABLE");
  assert.equal(issue?.field, "subject");
});

test("ai/absent mode is lenient on empty copy", () => {
  assert.equal(validateOutreachConfig({ outreachMode: "ai", subjectTemplate: "", bodyTemplate: "" }), null);
  assert.equal(validateOutreachConfig({ subjectTemplate: "", bodyTemplate: "" }), null);
});

console.log(`\n✓ outreachVariables (web): all ${passed} tests passed\n`);
