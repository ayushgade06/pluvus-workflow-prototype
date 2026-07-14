// HARD-O1: unit coverage for the LLM usage sink — wire-payload parsing and the
// AsyncLocalStorage attribution scope. No DB: parseLlmUsage is pure, and
// persistence is exercised only through its (test-env-disabled) gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLlmUsage,
  runWithLlmAttribution,
  currentLlmAttribution,
} from "./llmUsage.js";

function agentResponse(calls: unknown): Record<string, unknown> {
  return { intent: "POSITIVE", confidence: 0.9, llmUsage: { calls, totals: {} } };
}

const wireCall = {
  model: "anthropic:claude-opus-4-8",
  prompt_version: "classify-v1.1",
  latency_ms: 812.5,
  input_tokens: 100,
  output_tokens: 40,
  total_tokens: 140,
  est_cost_usd: 0.0015,
  ok: true,
  error_kind: null,
};

test("parseLlmUsage maps a wire call record to an insert row", () => {
  const rows = parseLlmUsage("classify", agentResponse([wireCall]), "inst_1");
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.instanceId, "inst_1");
  assert.equal(r.role, "classify");
  assert.equal(r.model, "anthropic:claude-opus-4-8");
  assert.equal(r.promptVersion, "classify-v1.1");
  assert.equal(r.latencyMs, 812.5);
  assert.equal(r.inputTokens, 100);
  assert.equal(r.outputTokens, 40);
  assert.equal(r.totalTokens, 140);
  assert.equal(r.estCostUsd, 0.0015);
  assert.equal(r.ok, true);
  assert.equal(r.errorKind, null);
});

test("parseLlmUsage keeps unreported tokens as null (distinct from 0)", () => {
  const rows = parseLlmUsage(
    "draft",
    agentResponse([{ model: "ollama:qwen3:8b", latency_ms: 40000, input_tokens: null }]),
    null,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.inputTokens, null);
  assert.equal(rows[0]!.totalTokens, null);
  assert.equal(rows[0]!.estCostUsd, null);
  assert.equal(rows[0]!.ok, true); // absent ok defaults to true
  assert.equal(rows[0]!.instanceId, null);
});

test("parseLlmUsage records a failed candidate call", () => {
  const rows = parseLlmUsage(
    "negotiate",
    agentResponse([{ model: "ollama:qwen3:8b", latency_ms: 60000, ok: false, error_kind: "LLMTimeoutError" }]),
    "inst_2",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ok, false);
  assert.equal(rows[0]!.errorKind, "LLMTimeoutError");
});

test("parseLlmUsage tolerates absent / malformed llmUsage", () => {
  assert.deepEqual(parseLlmUsage("classify", {}, "i"), []);
  assert.deepEqual(parseLlmUsage("classify", { llmUsage: null }, "i"), []);
  assert.deepEqual(parseLlmUsage("classify", { llmUsage: "garbage" }, "i"), []);
  assert.deepEqual(parseLlmUsage("classify", { llmUsage: { calls: "nope" } }, "i"), []);
  // Records missing the required model/latency are dropped; valid ones kept.
  const rows = parseLlmUsage(
    "classify",
    agentResponse([{ latency_ms: 5 }, { model: "m" }, 42, null, wireCall]),
    "i",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.model, "anthropic:claude-opus-4-8");
});

test("parseLlmUsage rounds fractional token counts to integers", () => {
  const rows = parseLlmUsage(
    "classify",
    agentResponse([{ model: "m", latency_ms: 1, input_tokens: 10.6 }]),
    null,
  );
  assert.equal(rows[0]!.inputTokens, 11);
});

test("attribution scope is visible inside and cleared outside", async () => {
  assert.equal(currentLlmAttribution(), null);
  const inside = await runWithLlmAttribution("inst_42", async () => {
    // Survives an await — the whole async subtree is attributed.
    await Promise.resolve();
    return currentLlmAttribution();
  });
  assert.equal(inside, "inst_42");
  assert.equal(currentLlmAttribution(), null);
});

test("nested/concurrent scopes stay isolated", async () => {
  const [a, b] = await Promise.all([
    runWithLlmAttribution("inst_a", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentLlmAttribution();
    }),
    runWithLlmAttribution("inst_b", async () => currentLlmAttribution()),
  ]);
  assert.equal(a, "inst_a");
  assert.equal(b, "inst_b");
});
