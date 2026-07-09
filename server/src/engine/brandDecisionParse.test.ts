/**
 * Unit tests for the deterministic brand-decision token scanner (§2.4). Pure —
 * no DB, no network, no agent. Proves that an explicit cue in the brand's reply
 * resolves to the right action (and amount) WITHOUT an AI hop, and that the
 * ambiguous / no-cue cases fall through to null so the AI fallback runs.
 *
 * Run with:  npx tsx src/engine/brandDecisionParse.test.ts
 */

import assert from "node:assert/strict";
import {
  scanBrandDecisionTokens,
  isAuthorizedBrandSender,
  mapReplyIntentToBrandDecision,
  BRAND_DECISION_LINK_SENDER,
} from "./brandDecisionParse.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nbrand-decision deterministic token scan\n");

// ── APPROVE ─────────────────────────────────────────────────────────────────
test("bare APPROVE resolves to APPROVE (confidence 1, source token)", () => {
  const r = scanBrandDecisionTokens("APPROVE");
  assert.equal(r?.decision, "APPROVE");
  assert.equal(r?.confidence, 1);
  assert.equal(r?.source, "token");
});

test("explicit 'ACCEPT' / 'AGREED' still resolve to APPROVE (close synonyms)", () => {
  assert.equal(scanBrandDecisionTokens("accept")?.decision, "APPROVE");
  assert.equal(scanBrandDecisionTokens("agreed, let's do it")?.decision, "APPROVE");
});

// MED-N1: the bare affirmatives "yes / ok / okay / go ahead / sounds good" are NO
// LONGER a deterministic APPROVE — they were too loose to authorize a real-money
// commitment. They fall through to null so the confidence-gated AI classifier
// (which cannot approve a QUESTION) decides, or the brand is re-asked.
test("'yes, go ahead' no longer deterministically APPROVEs (falls through to AI)", () => {
  assert.equal(scanBrandDecisionTokens("yes, go ahead"), null);
});

test("bare 'ok' / 'sounds good' no longer deterministically APPROVE", () => {
  assert.equal(scanBrandDecisionTokens("ok"), null);
  assert.equal(scanBrandDecisionTokens("that sounds good to me"), null);
});

// ── REJECT (and precedence over a stray affirmative) ─────────────────────────
test("REJECT resolves to REJECT", () => {
  assert.equal(scanBrandDecisionTokens("REJECT")?.decision, "REJECT");
});

test("'pass on this one' resolves to REJECT", () => {
  assert.equal(scanBrandDecisionTokens("let's pass on this one")?.decision, "REJECT");
});

// ── HANDOFF (wins over a stray affirmative) ──────────────────────────────────
test("HANDOFF resolves to HANDOFF", () => {
  assert.equal(scanBrandDecisionTokens("HANDOFF")?.decision, "HANDOFF");
});

test("'no, hand this to a human' → HANDOFF (handoff/reject before approve)", () => {
  // Contains no APPROVE synonym; 'human' triggers HANDOFF, and HANDOFF is
  // checked before REJECT here — either way it must NOT read as APPROVE.
  const r = scanBrandDecisionTokens("please have a human take over");
  assert.equal(r?.decision, "HANDOFF");
});

// ── COUNTER (requires a number) ──────────────────────────────────────────────
test("'COUNTER 350' resolves to COUNTER with value 350", () => {
  const r = scanBrandDecisionTokens("COUNTER 350");
  assert.equal(r?.decision, "COUNTER");
  assert.equal(r?.value, 350);
});

test("'counter at $1,200' parses the comma amount", () => {
  const r = scanBrandDecisionTokens("counter at $1,200 and that's final");
  assert.equal(r?.decision, "COUNTER");
  assert.equal(r?.value, 1200);
});

test("'COUNTER' with no number falls through to null (AI fallback / re-ask)", () => {
  assert.equal(scanBrandDecisionTokens("let's counter"), null);
});

// ── No cue → null (AI fallback) ──────────────────────────────────────────────
test("free-text with no cue returns null", () => {
  assert.equal(scanBrandDecisionTokens("hmm, not sure, what do you think?"), null);
});

test("empty body returns null", () => {
  assert.equal(scanBrandDecisionTokens(""), null);
});

// ── Sender-identity gate (CRITICAL-1) ────────────────────────────────────────
// A brand decision must come from the brand (campaign notifyEmail) or the
// verified magic-link channel — never the creator. isAuthorizedBrandSender is the
// pure predicate that guards executeBrandDecision.

console.log("\nbrand-decision sender-identity gate (CRITICAL-1)\n");

test("brand address (exact) is authorized", () => {
  assert.equal(isAuthorizedBrandSender("brand@acme.com", "brand@acme.com"), true);
});

test("brand address is matched case-insensitively / trimmed", () => {
  assert.equal(isAuthorizedBrandSender("  Brand@Acme.com ", "brand@acme.com"), true);
});

test("magic-link sentinel is authorized regardless of notifyEmail", () => {
  assert.equal(isAuthorizedBrandSender(BRAND_DECISION_LINK_SENDER, null), true);
  assert.equal(isAuthorizedBrandSender(BRAND_DECISION_LINK_SENDER, "brand@acme.com"), true);
});

test("CREATOR address is NOT authorized (the core exploit is blocked)", () => {
  // The creator whose over-ceiling ask triggered the escalation replies on their
  // own thread — must never resolve the brand's decision.
  assert.equal(isAuthorizedBrandSender("robin@creators.test", "brand@acme.com"), false);
});

test("a different third-party address is NOT authorized", () => {
  assert.equal(isAuthorizedBrandSender("someone@else.com", "brand@acme.com"), false);
});

test("missing sender is NOT authorized (conservative)", () => {
  assert.equal(isAuthorizedBrandSender(null, "brand@acme.com"), false);
  assert.equal(isAuthorizedBrandSender(undefined, "brand@acme.com"), false);
  assert.equal(isAuthorizedBrandSender("", "brand@acme.com"), false);
});

test("with no notifyEmail configured, only the magic-link channel resolves", () => {
  // An email reply can't be verified against a brand address that doesn't exist.
  assert.equal(isAuthorizedBrandSender("anyone@anywhere.com", null), false);
  assert.equal(isAuthorizedBrandSender(BRAND_DECISION_LINK_SENDER, null), true);
});

// ── AI-fallback intent mapping (MED-N1) ──────────────────────────────────────
console.log("\nbrand-decision AI intent mapping (MED-N1)\n");

test("POSITIVE → APPROVE (carries the classifier confidence)", () => {
  assert.deepEqual(mapReplyIntentToBrandDecision("POSITIVE", 0.9), {
    decision: "APPROVE",
    confidence: 0.9,
  });
});

test("NEGATIVE / OPT_OUT → REJECT", () => {
  assert.equal(mapReplyIntentToBrandDecision("NEGATIVE", 0.8).decision, "REJECT");
  assert.equal(mapReplyIntentToBrandDecision("OPT_OUT", 0.8).decision, "REJECT");
});

test("QUESTION → AMBIGUOUS (NOT approve) — the money-safety fix", () => {
  // A brand asking a question has not approved an over-ceiling spend; re-ask.
  const r = mapReplyIntentToBrandDecision("QUESTION", 0.95);
  assert.equal(r.decision, "AMBIGUOUS");
  assert.equal(r.confidence, 0); // forced re-ask regardless of classifier confidence
});

test("UNKNOWN / anything else → AMBIGUOUS", () => {
  assert.equal(mapReplyIntentToBrandDecision("UNKNOWN", 0.99).decision, "AMBIGUOUS");
  assert.equal(mapReplyIntentToBrandDecision("garbage", 0.99).decision, "AMBIGUOUS");
});

console.log(`\n${n} passed\n`);
