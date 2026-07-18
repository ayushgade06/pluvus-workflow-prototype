# P9 — Alerting, uptime, queue-failure visibility

**Goal:** the single operator gets notified within **minutes** of anything that
needs a human: the server going down, a payout/escalation email failing, an
instance parking for review, the LLM bill spiking, or jobs getting stuck.

Today there is one server and no alerting — a failure surfaces only if someone
happens to look. With real creators + money, a silent failure becomes a dispute.
This adds the two things a single operator actually needs: **one endpoint to
poll** and **a readable log**.

---

## 1. Uptime + one-poll alert roll-up

Point an uptime monitor (UptimeRobot, Better Uptime, a cron `curl`, Cloudflare
health check — anything) at these:

| Check | URL | Alert when |
|-------|-----|-----------|
| Server up | `GET /health` | non-200 / timeout |
| DB reachable | `GET /health/db` | non-200 |
| **Operator alerts** | `GET /observability/alerts` | JSON `status != "ok"` |

`/health` and `/health/db` are **open** (no key) so an external probe can reach
them. `/observability/alerts` is **gated** (send `X-Operator-Key:
$OPERATOR_API_KEY`) because it exposes operational detail.

### What `/observability/alerts` returns

A single roll-up of every "act now" signal, each judged to a severity, ordered
most-severe-first. `status` is `"ok"` when nothing fires, else the most severe
firing level (`critical` / `warning`).

```jsonc
{
  "status": "critical",
  "alerts": [
    { "id": "queue_failures",        "severity": "critical", "message": "...", "value": 103, "threshold": 1 },
    { "id": "manual_review_backlog", "severity": "warning",  "message": "...", "value": 3,   "threshold": null },
    { "id": "stuck_instances",       "severity": "warning",  "message": "...", "value": 2,   "threshold": 1 }
  ],
  "signals": { /* the raw numbers behind the judgment */ },
  "generatedAt": "2026-07-17T16:12:11.413Z"
}
```

The five signals (all pre-existing numbers, now judged in one place —
`server/src/observability/alerts.ts`):

| `id` | Fires when | Severity | Source |
|------|-----------|----------|--------|
| `queue_failures` | ≥1 failed BullMQ job (≥25 → critical) | warn/crit | `/queues/health` counts |
| `manual_review_backlog` | any instance in `MANUAL_REVIEW` | warning | instance state count |
| `failed_notifications` | any `BrandNotification` send FAILED (payout/escalation email never reached the operator) | critical | `BrandNotification.status` |
| `llm_spend_exceeded` | trailing-24h spend > `LLM_DAILY_SPEND_ALERT_USD` | critical | P4 spend guard |
| `stuck_instances` | non-terminal instances stranded past the stuck threshold (≥10 → critical) | warn/crit | `STUCK_STATE_AGE_MS` sweep backstop |

> The proto's only human-action park is `MANUAL_REVIEW`. (The parent Pluvus's
> `AWAITING_BRAND_DECISION` state does not exist in this schema — see the P9
> note in the go-live plan.)

**A cron example (page on anything but ok):**

```sh
STATUS=$(curl -sf -H "X-Operator-Key: $OPERATOR_API_KEY" \
  "$BASE_URL/observability/alerts" | jq -r .status)
[ "$STATUS" = "ok" ] || notify-operator "Pluvus alert: $STATUS"
```

### Clearing a stale queue-failure alert

A big `queue_failures` count is often just harness junk left in Redis (we saw
`failed:100`). Drain it with the P8 cleanup:
`npm run db:clean:harness:apply` (see `TEST_DATA_SEPARATION.md`), which removes
all failed jobs so the counter — and this alert — start clean.

---

## 2. Log-to-file (readable live log)

The server logs to **stdout only**; behind a tunnel / detached that stream is
gone. Set **`LOG_FILE`** (or **`LOG_DIR`**, which appends `server.log`) and every
`console.log/info/warn/error` line — including the structured `[transition]` /
`[trace]` / `[metrics]` lines, worker job failures, and escalation errors — is
**also** appended to that file with an ISO timestamp. stdout is unchanged; the
file is purely additive. Unset ⇒ no-op (stdout-only, as before).

```
# in the deployed env
LOG_DIR=/var/log/pluvus         # → /var/log/pluvus/server.log
# or an explicit file
LOG_FILE=/var/log/pluvus/server.log
```

```
tail -f /var/log/pluvus/server.log
grep '\[transition\]' /var/log/pluvus/server.log     # every state change
grep '\[error\]'      /var/log/pluvus/server.log     # failures
```

A write failure never crashes the app — it warns once and degrades to
stdout-only. Rotate the file with the platform's logrotate; the sink always
appends.

Implemented in `server/src/observability/logSink.ts`, installed first thing in
`server/src/index.ts` so startup lines are captured too.

---

## Acceptance

- Server down → `/health` probe fails → uptime monitor pages.
- A payout/escalation email fails → `failed_notifications` critical on
  `/observability/alerts` → `status: "critical"` → monitor pages.
- An instance parks in `MANUAL_REVIEW` → `manual_review_backlog` warning.
- With `LOG_DIR`/`LOG_FILE` set, `tail -f` shows the live log; a post-mortem has
  a file to read.
