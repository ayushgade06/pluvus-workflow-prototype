/**
 * Unit tests for Reward Setup reply detection. Covers the deterministic
 * agreement matcher and the classifier fallback (POSITIVE ⇒ confirm). Pure — no
 * DB, no network. Run:
 *   npx tsx src/engine/executors/rewardReply.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "@prisma/client";
import {
  isDeterministicAgreement,
  isAgreementReply,
  looksLikeRenegotiation,
} from "./rewardReply.js";
import type { IAgentProvider } from "../providers.js";
import type { ClassifyResult, EmailDraft, NegotiateResult } from "../types.js";

let n = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  const r = fn();
  if (r instanceof Promise) {
    // Tests here are synchronous or awaited inline below; keep the counter honest.
    throw new Error(`test "${name}" returned a promise — use runAsync`);
  }
  n++;
  console.log(`  ✓ ${name}`);
}

async function runAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// A stub agent whose classify() returns a fixed intent, to prove the fallback
// path is (or isn't) consulted. Only classify is exercised here.
function stubAgent(intent: ClassifyResult["intent"], confidence = 0.9): IAgentProvider {
  return {
    classify: async (): Promise<ClassifyResult> => ({ intent, confidence }),
    negotiate: async (): Promise<NegotiateResult> => ({ outcome: "escalate", message: "" }),
    draftEmail: async (): Promise<EmailDraft | null> => null,
  };
}

console.log("\nReward Setup reply detection\n");

// ── Deterministic agreement: ONLY the literal "I Agree" (MED-N4) ────────────
// Contract formation is a comprehension decision that belongs to the model; the
// deterministic allowlist is exactly the phrase the confirmation email requests.
test("'I Agree' matches", () => {
  assert.equal(isDeterministicAgreement("I Agree"), true);
});
test("'i agree' lowercase + trailing text matches", () => {
  assert.equal(isDeterministicAgreement("i agree, let's get started!"), true);
});

// ── Everything else is NOT deterministic — it goes to the classifier ───────
// (MED-N4: the old broad list let a hedged "yes, assuming…" form a contract by
// regex. These phrases still confirm when the classifier reads them POSITIVE —
// see the fallback tests below.)
test("'Confirmed' is no longer a deterministic match (classifier decides)", () => {
  assert.equal(isDeterministicAgreement("Confirmed"), false);
});
test("'Looks good' is no longer a deterministic match", () => {
  assert.equal(isDeterministicAgreement("Looks good to me"), false);
});
test("'I accept' is no longer a deterministic match", () => {
  assert.equal(isDeterministicAgreement("I accept the terms"), false);
});
test("leading 'Yes' is no longer a deterministic match", () => {
  assert.equal(isDeterministicAgreement("Yes, sounds perfect"), false);
});
test("'sounds good' is no longer a deterministic match", () => {
  assert.equal(isDeterministicAgreement("that sounds good"), false);
});

// ── Non-agreement text must NOT deterministically match ────────────────────
test("'I disagree' does NOT match agree", () => {
  assert.equal(isDeterministicAgreement("I disagree with the fee"), false);
});
test("a clarifying question does NOT match", () => {
  assert.equal(isDeterministicAgreement("Can you clarify the deliverables?"), false);
});
test("'before I confirm' (bare confirm in a question) does NOT match", () => {
  assert.equal(isDeterministicAgreement("One question before I confirm — when do we start?"), false);
});
test("'how do I confirm?' does NOT match", () => {
  assert.equal(isDeterministicAgreement("how do I confirm this?"), false);
});
test("empty / undefined → false", () => {
  assert.equal(isDeterministicAgreement(""), false);
  assert.equal(isDeterministicAgreement(undefined), false);
});

// ── Post-acceptance re-negotiation must NOT be treated as agreement ────────
// The deal is closed at a fixed fee; a reply that says "yes" AND tries to re-open
// the price must fall through to the "rate is fixed" auto-reply, never confirm.
test("'yes, but can you do $600?' does NOT deterministically agree", () => {
  assert.equal(isDeterministicAgreement("yes, but can you do $600?"), false);
});
test("'I agree if you can bump it to $700' does NOT agree", () => {
  assert.equal(isDeterministicAgreement("I agree if you can bump it to $700"), false);
});
test("'looks good, how about $500 instead' does NOT agree", () => {
  assert.equal(isDeterministicAgreement("looks good, how about $500 instead"), false);
});
test("looksLikeRenegotiation flags a dollar amount", () => {
  assert.equal(looksLikeRenegotiation("can we do $600"), true);
});
test("looksLikeRenegotiation flags 'increase'/'higher'", () => {
  assert.equal(looksLikeRenegotiation("can we increase it a bit"), true);
  assert.equal(looksLikeRenegotiation("I was hoping for something higher"), true);
});
test("a plain 'I Agree' is NOT flagged as renegotiation", () => {
  assert.equal(looksLikeRenegotiation("I Agree, let's go"), false);
});
test("a plain agreement still matches after the tightening", () => {
  // Guards against the renegotiation filter being over-broad.
  assert.equal(isDeterministicAgreement("Yes, sounds perfect — I Agree"), true);
});

// isAgreementReply: a "yes + counter" is reported as RENEGOTIATION, not confirmed,
// even when the classifier would read the affirmative tone as POSITIVE.
await runAsync("'yes but $600' is not confirmed even if classifier says POSITIVE", async () => {
  const r = await isAgreementReply("yes, but can you do $600?", stubAgent("POSITIVE"));
  assert.equal(r.confirmed, false);
  assert.equal(r.intent, "RENEGOTIATION");
});

// ── isAgreementReply: deterministic wins without calling the classifier ────
const throwingAgent: IAgentProvider = {
  classify: async () => {
    throw new Error("classifier should not be called on a deterministic match");
  },
  negotiate: async (): Promise<NegotiateResult> => ({ outcome: "escalate", message: "" }),
  draftEmail: async () => null,
};

const _creator: Creator = {} as Creator; // unused by these paths; kept for clarity

await runAsync("deterministic agreement confirms without consulting the agent", async () => {
  const r = await isAgreementReply("I Agree!", throwingAgent);
  assert.equal(r.confirmed, true);
  assert.equal(r.intent, "AGREEMENT");
});

// ── Classifier fallback: POSITIVE confirms, others do not ──────────────────
await runAsync("classifier POSITIVE confirms", async () => {
  const r = await isAgreementReply("great, count me in", stubAgent("POSITIVE"));
  assert.equal(r.confirmed, true);
  assert.equal(r.intent, "POSITIVE");
});

// MED-N4: the phrases dropped from the deterministic list still confirm when
// the model comprehends them as agreement.
await runAsync("'Confirmed, thanks!' confirms via the classifier", async () => {
  const r = await isAgreementReply("Confirmed, thanks!", stubAgent("POSITIVE"));
  assert.equal(r.confirmed, true);
  assert.equal(r.intent, "POSITIVE");
});

await runAsync("classifier QUESTION does NOT confirm (stays pending)", async () => {
  const r = await isAgreementReply("what about the timeline?", stubAgent("QUESTION"));
  assert.equal(r.confirmed, false);
  assert.equal(r.intent, "QUESTION");
});

await runAsync("classifier NEGATIVE does NOT confirm", async () => {
  const r = await isAgreementReply("actually I want to reconsider", stubAgent("NEGATIVE"));
  assert.equal(r.confirmed, false);
});

await runAsync("classifier UNKNOWN does NOT confirm", async () => {
  const r = await isAgreementReply("hmm", stubAgent("UNKNOWN", 0.3));
  assert.equal(r.confirmed, false);
});

console.log(`\n${n} passed\n`);
