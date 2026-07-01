/**
 * Unit tests for Reward Setup reply detection. Covers the deterministic
 * agreement matcher and the classifier fallback (POSITIVE ⇒ confirm). Pure — no
 * DB, no network. Run:
 *   npx tsx src/engine/executors/rewardReply.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "@prisma/client";
import { isDeterministicAgreement, isAgreementReply } from "./rewardReply.js";
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

// ── Deterministic agreement phrases (the ones the email asks for) ──────────
test("'I Agree' matches", () => {
  assert.equal(isDeterministicAgreement("I Agree"), true);
});
test("'i agree' lowercase + trailing text matches", () => {
  assert.equal(isDeterministicAgreement("i agree, let's get started!"), true);
});
test("'Confirmed' matches", () => {
  assert.equal(isDeterministicAgreement("Confirmed"), true);
});
test("'Looks good' matches", () => {
  assert.equal(isDeterministicAgreement("Looks good to me"), true);
});
test("'I accept' matches", () => {
  assert.equal(isDeterministicAgreement("I accept the terms"), true);
});
test("leading 'Yes' matches", () => {
  assert.equal(isDeterministicAgreement("Yes, sounds perfect"), true);
});
test("'sounds good' matches", () => {
  assert.equal(isDeterministicAgreement("that sounds good"), true);
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
test("standalone 'Confirmed' still matches", () => {
  assert.equal(isDeterministicAgreement("Confirmed, thanks!"), true);
});
test("empty / undefined → false", () => {
  assert.equal(isDeterministicAgreement(""), false);
  assert.equal(isDeterministicAgreement(undefined), false);
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
