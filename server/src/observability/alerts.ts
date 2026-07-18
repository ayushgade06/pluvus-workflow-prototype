// ---------------------------------------------------------------------------
// Operator alerts aggregator (P9 / single-operator go-live)
// ---------------------------------------------------------------------------
// One server, no error alerting: a failed payout email, a stuck instance, or a
// negotiation loop running up an LLM bill currently surfaces only if someone
// happens to look at the right dashboard tab. With real creators + real money,
// silent failures become disputes. This module rolls every "the operator should
// act NOW" signal into ONE read so a dumb uptime monitor / cron `curl` can poll
// a single endpoint (GET /observability/alerts) and page the operator.
//
// The signals it aggregates (all already computed elsewhere — this just judges
// them against thresholds and labels the severity):
//   1. queue FAILED jobs growing        (workerMetrics.collectWorkerMetrics)
//   2. instances PARKED for a human      (MANUAL_REVIEW count — the proto's only
//                                         human-action park; the parent's
//                                         AWAITING_BRAND_DECISION does not exist
//                                         in this schema)
//   3. FAILED brand/escalation emails    (BrandNotification.status = FAILED — a
//                                         payout/escalation notice that never
//                                         reached the operator)
//   4. LLM daily SPEND guard exceeded    (computeSpendGuard / LLM_DAILY_SPEND_ALERT_USD)
//   5. STUCK non-terminal instances      (workerMetrics.stuckTotal backstop)
//
// The evaluator is PURE (no I/O) so the thresholds + severity logic are
// unit-testable; the gather step (repository) feeds it live numbers.

export type AlertSeverity = "critical" | "warning" | "info";

export interface OperatorAlert {
  /** Stable machine key so a monitor can dedupe / route (e.g. page vs slack). */
  id:
    | "queue_failures"
    | "manual_review_backlog"
    | "failed_notifications"
    | "llm_spend_exceeded"
    | "stuck_instances";
  severity: AlertSeverity;
  /** Human-readable one-liner for the operator. */
  message: string;
  /** The measured value that triggered (or didn't trigger) the alert. */
  value: number;
  /** The threshold the value was compared against (null = any non-zero fires). */
  threshold: number | null;
}

export interface AlertInputs {
  /** Total FAILED jobs across all BullMQ queues (right now). */
  queueFailedTotal: number;
  /** Per-queue failed counts, for the message detail. */
  queueFailedByName: Record<string, number>;
  /** Instances parked in MANUAL_REVIEW awaiting a human. */
  manualReviewCount: number;
  /** BrandNotification rows whose send FAILED (operator never got the email). */
  failedNotificationCount: number;
  /** Non-terminal instances stranded past the stuck threshold. */
  stuckInstanceCount: number;
  /** LLM daily spend monitor: did trailing-24h spend cross the configured cap? */
  spendExceeded: boolean;
  /** Trailing-24h estimated spend (USD), for the message. */
  spendUsd: number;
  /** The configured daily spend threshold (USD), or null when the monitor is off. */
  spendThresholdUsd: number | null;
}

// Thresholds. Deliberately conservative for a single operator: parks + failed
// emails are actionable at ANY non-zero count (someone must act), while queue
// failures and stuck instances get a small floor so a single transient retry
// blip doesn't page anyone.
const QUEUE_FAILED_WARN = 1; // ≥1 failed job → warning (they're retained, so investigate)
const QUEUE_FAILED_CRIT = 25; // a pile-up = the workers/agent are broken
const STUCK_WARN = 1;
const STUCK_CRIT = 10;

/**
 * Judge the live signals into a list of alerts. Pure. Only returns alerts that
 * are actually firing (empty array ⇒ all clear). Ordered most-severe first so a
 * monitor can act on `alerts[0]`.
 */
export function evaluateAlerts(inputs: AlertInputs): OperatorAlert[] {
  const alerts: OperatorAlert[] = [];

  // 1. Queue failures.
  if (inputs.queueFailedTotal >= QUEUE_FAILED_WARN) {
    const detail = Object.entries(inputs.queueFailedByName)
      .filter(([, n]) => n > 0)
      .map(([q, n]) => `${q}=${n}`)
      .join(", ");
    alerts.push({
      id: "queue_failures",
      severity: inputs.queueFailedTotal >= QUEUE_FAILED_CRIT ? "critical" : "warning",
      message:
        `${inputs.queueFailedTotal} failed queue job(s)` +
        (detail ? ` (${detail})` : "") +
        " - a node-execution / inbound-email step is erroring; check /queues/jobs.",
      value: inputs.queueFailedTotal,
      threshold: QUEUE_FAILED_WARN,
    });
  }

  // 2. Manual-review backlog — any parked instance needs a human.
  if (inputs.manualReviewCount > 0) {
    alerts.push({
      id: "manual_review_backlog",
      severity: "warning",
      message:
        `${inputs.manualReviewCount} instance(s) parked in MANUAL_REVIEW ` +
        "awaiting operator action - see the Manual Queue.",
      value: inputs.manualReviewCount,
      threshold: null,
    });
  }

  // 3. Failed brand/escalation emails — the operator may not know a creator
  //    escalated, or that a payout notice never sent.
  if (inputs.failedNotificationCount > 0) {
    alerts.push({
      id: "failed_notifications",
      severity: "critical",
      message:
        `${inputs.failedNotificationCount} brand/escalation email(s) FAILED to send ` +
        "- the operator was not notified of an escalation or payout event.",
      value: inputs.failedNotificationCount,
      threshold: null,
    });
  }

  // 4. LLM daily spend guard.
  if (inputs.spendExceeded && inputs.spendThresholdUsd !== null) {
    alerts.push({
      id: "llm_spend_exceeded",
      severity: "critical",
      message:
        `LLM spend $${inputs.spendUsd.toFixed(2)} in the last 24h exceeded the ` +
        `$${inputs.spendThresholdUsd.toFixed(2)} daily alert threshold ` +
        "(LLM_DAILY_SPEND_ALERT_USD) - a run may be looping.",
      value: inputs.spendUsd,
      threshold: inputs.spendThresholdUsd,
    });
  }

  // 5. Stuck non-terminal instances (backstop — the sweep should re-enqueue; a
  //    persistent count means jobs are being lost).
  if (inputs.stuckInstanceCount >= STUCK_WARN) {
    alerts.push({
      id: "stuck_instances",
      severity: inputs.stuckInstanceCount >= STUCK_CRIT ? "critical" : "warning",
      message:
        `${inputs.stuckInstanceCount} non-terminal instance(s) stranded past the ` +
        "stuck threshold - the scheduler sweep may not be advancing them.",
      value: inputs.stuckInstanceCount,
      threshold: STUCK_WARN,
    });
  }

  const rank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface AlertsReportDTO {
  /** "ok" when nothing is firing, else the most severe firing level. */
  status: "ok" | AlertSeverity;
  alerts: OperatorAlert[];
  /** The raw numbers behind the judgment, for the dashboard / debugging. */
  signals: AlertInputs;
  generatedAt: string;
}

/** Roll the evaluated alerts into a report with an at-a-glance top-level status. */
export function buildAlertsReport(inputs: AlertInputs, generatedAt: string): AlertsReportDTO {
  const alerts = evaluateAlerts(inputs);
  const status: AlertsReportDTO["status"] = alerts.length === 0 ? "ok" : alerts[0]!.severity;
  return { status, alerts, signals: inputs, generatedAt };
}
