/**
 * P9 — the operator alerts evaluator is what an uptime monitor polls to decide
 * whether to page a human. This locks the threshold + severity logic: when each
 * signal fires, at what severity, and that an all-clear returns "ok".
 *
 * Run: npx tsx --test src/observability/alerts.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAlerts, buildAlertsReport, type AlertInputs } from "./alerts.js";

const CLEAR: AlertInputs = {
  queueFailedTotal: 0,
  queueFailedByName: { "node-execution": 0, "inbound-email": 0 },
  manualReviewCount: 0,
  failedNotificationCount: 0,
  stuckInstanceCount: 0,
  spendExceeded: false,
  spendUsd: 0,
  spendThresholdUsd: null,
};

test("P9: all-clear fires no alerts and reports status ok", () => {
  const alerts = evaluateAlerts(CLEAR);
  assert.equal(alerts.length, 0);
  const report = buildAlertsReport(CLEAR, "2026-07-17T00:00:00.000Z");
  assert.equal(report.status, "ok");
  assert.deepEqual(report.alerts, []);
});

test("P9: any failed queue job fires a warning; a pile-up is critical", () => {
  const warn = evaluateAlerts({ ...CLEAR, queueFailedTotal: 3, queueFailedByName: { "node-execution": 3 } });
  assert.equal(warn.length, 1);
  assert.equal(warn[0]?.id, "queue_failures");
  assert.equal(warn[0]?.severity, "warning");

  const crit = evaluateAlerts({ ...CLEAR, queueFailedTotal: 100, queueFailedByName: { "node-execution": 100 } });
  assert.equal(crit[0]?.severity, "critical");
});

test("P9: any parked instance fires a manual-review warning", () => {
  const alerts = evaluateAlerts({ ...CLEAR, manualReviewCount: 1 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.id, "manual_review_backlog");
  assert.equal(alerts[0]?.severity, "warning");
});

test("P9: a failed brand/escalation email is critical (operator not reached)", () => {
  const alerts = evaluateAlerts({ ...CLEAR, failedNotificationCount: 2 });
  assert.equal(alerts[0]?.id, "failed_notifications");
  assert.equal(alerts[0]?.severity, "critical");
});

test("P9: spend guard only fires when exceeded AND a threshold is configured", () => {
  // exceeded but no threshold (monitor off) → no alert
  assert.equal(
    evaluateAlerts({ ...CLEAR, spendExceeded: true, spendThresholdUsd: null }).length,
    0,
  );
  // exceeded with threshold → critical
  const fired = evaluateAlerts({ ...CLEAR, spendExceeded: true, spendUsd: 30, spendThresholdUsd: 25 });
  assert.equal(fired[0]?.id, "llm_spend_exceeded");
  assert.equal(fired[0]?.severity, "critical");
});

test("P9: stuck instances warn below the floor, critical above", () => {
  assert.equal(evaluateAlerts({ ...CLEAR, stuckInstanceCount: 2 })[0]?.severity, "warning");
  assert.equal(evaluateAlerts({ ...CLEAR, stuckInstanceCount: 50 })[0]?.severity, "critical");
});

test("P9: report status is the most severe firing level, alerts sorted critical-first", () => {
  const inputs: AlertInputs = {
    ...CLEAR,
    manualReviewCount: 1, // warning
    failedNotificationCount: 1, // critical
  };
  const report = buildAlertsReport(inputs, "2026-07-17T00:00:00.000Z");
  assert.equal(report.status, "critical");
  assert.equal(report.alerts[0]?.severity, "critical");
  assert.equal(report.alerts.length, 2);
});
