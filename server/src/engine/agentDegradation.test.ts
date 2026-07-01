/**
 * Graceful-degradation tests for the agent provider adapter (FIX-9).
 *
 * Proves that when the underlying classification / negotiation / draft provider
 * throws (agent service down, circuit open, malformed response), the adapter
 * degrades to the existing SAFE seams instead of propagating — so the worker
 * never strands an instance at REPLY_RECEIVED and never guesses a money
 * decision:
 *   classify   → UNKNOWN / confidence 0  (low-confidence gate → MANUAL_REVIEW)
 *   negotiate  → outcome "escalate"      (executor            → MANUAL_REVIEW)
 *   draftEmail → null (after retries)    (outreach/follow-up  → template copy;
 *                                         negotiation offer turns → MANUAL_REVIEW)
 *
 * Run with:  npx tsx src/engine/agentDegradation.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "@prisma/client";
import { AgentProviderAdapter } from "./providerFactory.js";
import type { ClassificationProvider } from "../adapters/classification/ClassificationProvider.js";
import type { NegotiationProvider } from "../adapters/negotiation/NegotiationProvider.js";

let n = 0;
function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(() => {
    n++;
    console.log(`  ✓ ${name}`);
  });
}

const boom = () => {
  throw new Error("agent service unreachable");
};

// Providers whose every method throws (simulates a down agent service / open
// circuit, both of which surface as a thrown error to the adapter).
const failingClassifier: ClassificationProvider = { classify: async () => boom() };
const failingNegotiator: NegotiationProvider = {
  negotiate: async () => boom(),
  draft: async () => boom(),
};

const okClassifier: ClassificationProvider = {
  classify: async () => ({ intent: "POSITIVE", confidence: 0.9 }),
};
const okNegotiator: NegotiationProvider = {
  negotiate: async () => ({ action: "ACCEPT", proposedTerms: { rate: 300 }, responseDraft: "deal" }),
  draft: async () => ({ subject: "s", body: "b" }),
};

const fakeCreator = { name: "Robin", platform: "instagram", niche: "fitness" } as unknown as Creator;
const config = { termFloor: { rate: 100 }, termCeiling: { rate: 500 } };

async function main() {
  console.log("\nagentProvider graceful degradation (FIX-9)\n");

  await test("classify failure degrades to UNKNOWN / confidence 0", async () => {
    const adapter = new AgentProviderAdapter(failingClassifier, okNegotiator, {});
    const r = await adapter.classify("hello");
    assert.equal(r.intent, "UNKNOWN");
    assert.equal(r.confidence, 0);
  });

  await test("classify success is passed through unchanged", async () => {
    const adapter = new AgentProviderAdapter(okClassifier, okNegotiator, {});
    const r = await adapter.classify("hello");
    assert.equal(r.intent, "POSITIVE");
    assert.equal(r.confidence, 0.9);
  });

  await test("negotiate failure degrades to escalate (never guesses money)", async () => {
    const adapter = new AgentProviderAdapter(okClassifier, failingNegotiator, {});
    const r = await adapter.negotiate(0, config, "I want $400");
    assert.equal(r.outcome, "escalate");
    assert.equal(r.proposedRate, undefined);
  });

  await test("negotiate success is mapped through unchanged", async () => {
    const adapter = new AgentProviderAdapter(okClassifier, okNegotiator, {});
    const r = await adapter.negotiate(0, config, "ok");
    assert.equal(r.outcome, "accept");
    assert.equal(r.proposedRate, 300);
  });

  await test("draftEmail failure degrades to null (template fallback)", async () => {
    const adapter = new AgentProviderAdapter(okClassifier, failingNegotiator, {});
    const r = await adapter.draftEmail("initial_outreach", fakeCreator, config);
    assert.equal(r, null);
  });

  await test("draftEmail success returns the draft", async () => {
    const adapter = new AgentProviderAdapter(okClassifier, okNegotiator, {});
    const r = await adapter.draftEmail("acceptance", fakeCreator, config);
    assert.deepEqual(r, { subject: "s", body: "b" });
  });

  // The real adapter marks itself as generating LLM copy — this is the flag the
  // negotiation executor keys on to decide "null draft ⇒ escalate to a human"
  // (real path) vs "null draft ⇒ use the template" (mock path). If this flips,
  // the executor would wrongly escalate mock-mode turns or wrongly auto-send the
  // sparse fallback on the real path.
  await test("real adapter advertises generatesDraftCopy = true", async () => {
    const adapter = new AgentProviderAdapter(okClassifier, okNegotiator, {});
    assert.equal(adapter.generatesDraftCopy, true);
  });

  await test("MockAgentProvider does NOT advertise generatesDraftCopy", async () => {
    const { MockAgentProvider } = await import("./providers.js");
    const mock = new MockAgentProvider();
    assert.notEqual(mock.generatesDraftCopy, true);
  });

  console.log(`\n✓ agentDegradation: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
