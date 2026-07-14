/**
 * H2 — intent-allowlist drift guard.
 *
 * The set of valid reply intents historically lived, hand-maintained, in FOUR
 * places: the DB enum, the TS classify-provider allowlist, the worker's
 * mockIntent list, and the `ReplyIntentValue` type. They drifted once already —
 * the classify allowlist omitted DEFERRED, so every "I'll think about it" reply
 * degraded to UNKNOWN → MANUAL_REVIEW and Phase D never worked E2E (fixed in
 * 65897d1). This test makes that drift a CI failure instead of a live incident.
 *
 * The runtime allowlists are now DERIVED from `replyIntentEnum.enumValues` (the
 * single source of truth), so these assertions confirm the derivation holds and
 * lock it in should anyone re-introduce a hardcoded copy. The `ReplyIntentValue`
 * type is checked structurally at compile time below.
 *
 * Run: npx tsx --test src/adapters/classification/LangGraphClassificationProvider.intents.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { replyIntentEnum, type ReplyIntent } from "../../db/schema.js";
import { VALID_INTENTS as CLASSIFY_VALID_INTENTS } from "./LangGraphClassificationProvider.js";
import { VALID_INTENTS as WORKER_VALID_INTENTS } from "../../workers/inboundEmailWorker.js";
import type { ReplyIntentValue } from "./types.js";

// The enum is the source of truth. Sorted for order-independent set comparison.
const ENUM_VALUES = [...replyIntentEnum.enumValues].sort();

test("H2: classify provider allowlist equals the ReplyIntent enum", () => {
  assert.deepEqual([...CLASSIFY_VALID_INTENTS].sort(), ENUM_VALUES);
});

test("H2: inbound worker mockIntent allowlist equals the ReplyIntent enum", () => {
  assert.deepEqual([...WORKER_VALID_INTENTS].sort(), ENUM_VALUES);
});

test("H2: DEFERRED specifically is accepted everywhere (the exact bug that shipped)", () => {
  // The one that caused the incident — assert it explicitly so a regression reads
  // clearly in the failure output, not just as an opaque set mismatch.
  assert.ok(replyIntentEnum.enumValues.includes("DEFERRED"), "enum must contain DEFERRED");
  assert.ok(CLASSIFY_VALID_INTENTS.has("DEFERRED"), "classify allowlist must contain DEFERRED");
  assert.ok(
    (WORKER_VALID_INTENTS as readonly string[]).includes("DEFERRED"),
    "worker allowlist must contain DEFERRED",
  );
});

test("H2: the ReplyIntentValue type is structurally identical to the enum's union", () => {
  // Compile-time bidirectional assignability: if `ReplyIntentValue` (the
  // hand-maintained type in types.ts) ever adds or drops a member relative to the
  // DB enum's `ReplyIntent` union, one of these assignments fails to compile —
  // turning type drift into a build break under tsc. Runtime is a no-op.
  const _fromEnum: ReplyIntentValue = "POSITIVE" as ReplyIntent;
  const _toEnum: ReplyIntent = "POSITIVE" as ReplyIntentValue;
  void _fromEnum;
  void _toEnum;
  assert.ok(true);
});
