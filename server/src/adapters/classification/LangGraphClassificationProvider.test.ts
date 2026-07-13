/**
 * Regression test for the stale-intent-allowlist bug class.
 *
 * LangGraphClassificationProvider validates the agent's `intent` against a
 * hand-maintained VALID_INTENTS set. When an intent is added to the agent /
 * ReplyIntentValue / the Prisma enum but NOT to that set, the provider rejects
 * the otherwise-valid agent response as "malformed" and throws — which
 * providerFactory then degrades to UNKNOWN@0 → MANUAL_REVIEW. That is exactly
 * how Phase D's DEFERRED intent was silently swallowed: the agent returned
 * DEFERRED@0.95 for every "I'll think about it" reply, this allowlist didn't
 * list it, and the reply was mis-routed to a human instead of the follow-up loop.
 *
 * This test drives the provider against a stubbed agent response for EVERY valid
 * intent and asserts it passes through without throwing, and that a genuinely
 * unknown intent still throws.
 *
 * Run: npx tsx --test src/adapters/classification/LangGraphClassificationProvider.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LangGraphClassificationProvider } from "./LangGraphClassificationProvider.js";
import type { ReplyIntentValue } from "./types.js";
import { resetAgentBreaker } from "../agentServiceClient.js";

// Stub the global fetch with a canned agent response so the provider's HTTP call
// resolves to our JSON without a real network / running agent.
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

// The full set of intents the agent can return. Keep in sync with the Prisma
// ReplyIntent enum / ReplyIntentValue — if you add one here, VALID_INTENTS in the
// provider must accept it too (that's the bug this file guards).
const ALL_INTENTS: ReplyIntentValue[] = [
  "POSITIVE",
  "NEGATIVE",
  "QUESTION",
  "OPT_OUT",
  "UNKNOWN",
  "DEFERRED",
];

for (const intent of ALL_INTENTS) {
  test(`accepts agent intent ${intent} without degrading`, async () => {
    const restore = stubFetch({ intent, confidence: 0.95, reasoning: "x" });
    try {
      const provider = new LangGraphClassificationProvider("http://agent.test");
      const res = await provider.classify({ message: "I'll think about it." });
      assert.equal(res.intent, intent, `intent ${intent} must survive the seam`);
      assert.equal(res.confidence, 0.95);
    } finally {
      restore();
    }
  });
}

test("DEFERRED specifically is not rejected as malformed (Phase D regression)", async () => {
  // The exact response shape the agent returns for a deferral reply. Before the
  // fix this threw "malformed agent response" and degraded to UNKNOWN.
  const restore = stubFetch({
    intent: "DEFERRED",
    confidence: 0.95,
    reasoning: "The creator wants time to consider.",
    escalationReason: null,
  });
  try {
    const provider = new LangGraphClassificationProvider("http://agent.test");
    const res = await provider.classify({ message: "Let me get back to you next week." });
    assert.equal(res.intent, "DEFERRED");
    assert.equal(res.confidence, 0.95);
  } finally {
    restore();
  }
});

test("a genuinely unknown intent still throws (validation not disabled)", async () => {
  const restore = stubFetch({ intent: "MAYBE_LATER", confidence: 0.9 });
  try {
    const provider = new LangGraphClassificationProvider("http://agent.test");
    await assert.rejects(
      () => provider.classify({ message: "hi" }),
      /malformed agent response/,
    );
  } finally {
    restore();
  }
});

test("carries escalationReason across the seam when present", async () => {
  const restore = stubFetch({
    intent: "UNKNOWN",
    confidence: 0,
    escalationReason: "usage_rights_or_licensing",
  });
  try {
    const provider = new LangGraphClassificationProvider("http://agent.test");
    const res = await provider.classify({ message: "do I keep usage rights?" });
    assert.equal(res.escalationReason, "usage_rights_or_licensing");
  } finally {
    restore();
  }
});
