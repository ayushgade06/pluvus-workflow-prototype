/**
 * Template invariants for the negotiation opening position (V1 #2, Phase B).
 *
 * Founder #2: open at the FLOOR (preferred budget) and concede up —
 * recommendedOfferPosition is 0.0 in every template. Opening at the floor is
 * only safe because every template keeps minBudget > 0 (HARD-N3: a zero floor
 * plus open-at-floor once produced a $0 opening offer for a bare
 * "I'm interested" reply). These tests lock BOTH halves of that contract so
 * neither can regress independently.
 *
 * Run with:  npx tsx --test src/templates/templates.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_TEMPLATES } from "./index.js";
import { resolveBand } from "../engine/band.js";

const negotiationConfigs = Object.values(WORKFLOW_TEMPLATES).map((tpl) => {
  const node = tpl.nodes.find((n) => n.type === "NEGOTIATION");
  assert.ok(node, `template ${tpl.key} must have a NEGOTIATION node`);
  return { key: tpl.key, config: node.config as Record<string, unknown> };
});

test("every template opens at the floor (recommendedOfferPosition 0.0)", () => {
  for (const { key, config } of negotiationConfigs) {
    assert.equal(
      config["recommendedOfferPosition"],
      0.0,
      `${key}: V1 #2 — open at the floor, concede up`,
    );
  }
});

test("every template keeps minBudget > 0 (HARD-N3 $0-offer guard)", () => {
  for (const { key, config } of negotiationConfigs) {
    const floor = config["minBudget"];
    assert.equal(typeof floor, "number", `${key}: minBudget must be a number`);
    assert.ok(
      (floor as number) > 0,
      `${key}: minBudget must be > 0 — open-at-floor with a $0 floor recreates the $0-offer bug`,
    );
  }
});

test("bare 'I'm interested' opening offer is the floor, never $0", () => {
  // Mirror the agent's recommended-offer math (negotiate.py):
  //   recommended = floor + (ceiling - floor) * position
  // With position 0.0 that is exactly the floor, which must be positive.
  for (const { key, config } of negotiationConfigs) {
    const band = resolveBand(config);
    assert.ok(band.floor !== undefined, `${key}: band floor must resolve`);
    assert.ok(band.ceiling !== undefined, `${key}: band ceiling must resolve`);

    const position = config["recommendedOfferPosition"] as number;
    const opening = band.floor! + (band.ceiling! - band.floor!) * position;
    assert.equal(opening, band.floor, `${key}: opening offer must be the floor`);
    assert.ok(opening > 0, `${key}: opening offer must never be $0`);
  }
});
