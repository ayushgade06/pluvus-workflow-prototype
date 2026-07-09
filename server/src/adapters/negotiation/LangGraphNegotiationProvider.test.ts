/**
 * HARD-T1: regression test for the field-dropping adapter bug class.
 *
 * LangGraphNegotiationProvider reconstructs the NegotiationResponse field-by-field
 * from the raw HTTP JSON, so any field the reconstruction FORGETS to copy is
 * silently dropped before the executor ever sees it. This has bitten the
 * comprehension fields (creatorQuestions / pushedFixedTerms / creatorRequestedRate)
 * before — the executor's money path and the /draft question checklist depend on
 * them surviving the seam. This test drives the provider against a stubbed agent
 * response and asserts every field is carried across.
 *
 * Run: npx tsx --test src/adapters/negotiation/LangGraphNegotiationProvider.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LangGraphNegotiationProvider } from "./LangGraphNegotiationProvider.js";
import { resetAgentBreaker } from "../agentServiceClient.js";

// Stub the global fetch with a canned agent response, so the provider's HTTP
// call resolves to our JSON without a real network / running agent.
function stubFetch(jsonBody: unknown, status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(jsonBody), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    resetAgentBreaker();
  };
}

const baseReq = {
  creatorReply: "Can we do 15% commission? And when does it go live?",
  currentOffer: { rate: 400 },
  round: 2,
  maxRounds: 4,
  negotiationHistory: [],
  campaignConstraints: {
    termFloor: { rate: 200 },
    termCeiling: { rate: 500 },
  },
};

test("negotiate() carries ALL comprehension fields across the HTTP seam", async () => {
  const restore = stubFetch({
    action: "COUNTER",
    proposedTerms: { rate: 420 },
    responseDraft: "Here's our counter…",
    reasoning: "step down from the ask",
    creatorQuestions: ["can we do 15% commission?", "when does it go live?"],
    pushedFixedTerms: ["commission"],
    creatorRequestedRate: 450,
  });
  try {
    const provider = new LangGraphNegotiationProvider("http://agent.test");
    const resp = await provider.negotiate(baseReq);

    assert.equal(resp.action, "COUNTER");
    assert.deepEqual(resp.proposedTerms, { rate: 420 });
    assert.equal(resp.responseDraft, "Here's our counter…");
    assert.equal(resp.reasoning, "step down from the ask");
    // The field-drop regression targets: these MUST survive the reconstruction.
    assert.deepEqual(resp.creatorQuestions, [
      "can we do 15% commission?",
      "when does it go live?",
    ]);
    assert.deepEqual(resp.pushedFixedTerms, ["commission"]);
    assert.equal(resp.creatorRequestedRate, 450);
  } finally {
    restore();
  }
});

test("negotiate() omits comprehension fields that are absent/malformed (no crash)", async () => {
  const restore = stubFetch({
    action: "PRESENT_OFFER",
    // No creatorQuestions/pushedFixedTerms/creatorRequestedRate at all.
  });
  try {
    const provider = new LangGraphNegotiationProvider("http://agent.test");
    const resp = await provider.negotiate(baseReq);
    assert.equal(resp.action, "PRESENT_OFFER");
    assert.equal(resp.creatorQuestions, undefined);
    assert.equal(resp.pushedFixedTerms, undefined);
    assert.equal(resp.creatorRequestedRate, undefined);
  } finally {
    restore();
  }
});

test("negotiate() drops a non-string-array creatorQuestions rather than passing junk", async () => {
  const restore = stubFetch({
    action: "COUNTER",
    proposedTerms: { rate: 420 },
    creatorQuestions: [1, 2, 3], // malformed: not strings
    creatorRequestedRate: "not a number",
  });
  try {
    const provider = new LangGraphNegotiationProvider("http://agent.test");
    const resp = await provider.negotiate(baseReq);
    assert.equal(resp.creatorQuestions, undefined); // junk array omitted
    assert.equal(resp.creatorRequestedRate, undefined); // non-number omitted
  } finally {
    restore();
  }
});

test("draft() returns subject+body and threads the full request through", async () => {
  let capturedBody: unknown;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
    return new Response(JSON.stringify({ subject: "Our offer", body: "Hi there…" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const provider = new LangGraphNegotiationProvider("http://agent.test");
    const resp = await provider.draft({
      purpose: "counter_offer",
      creatorName: "Ada",
      // HARD-N2/K1: history + openQuestions must reach the agent verbatim.
      history: [{ role: "creator", message: "what's the fee?" }],
      openQuestions: ["when do I get paid?"],
      creatorQuestions: ["what's the fee?"],
    });
    assert.equal(resp.subject, "Our offer");
    assert.equal(resp.body, "Hi there…");
    const sent = capturedBody as Record<string, unknown>;
    assert.deepEqual(sent["history"], [{ role: "creator", message: "what's the fee?" }]);
    assert.deepEqual(sent["openQuestions"], ["when do I get paid?"]);
  } finally {
    globalThis.fetch = original;
    resetAgentBreaker();
  }
});
