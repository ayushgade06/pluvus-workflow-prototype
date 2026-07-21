# P10 — Secrets hygiene & inventory

**Goal:** no production secret lives in the repo; every secret is documented,
rotatable, and stored in the deploy platform's secret store (not a committed
file).

---

## Posture (verified)

- `.env` and `.env.local` are **gitignored** (`.gitignore:12-14`) and have
  **never been committed** (`git ls-files` shows only `.env.example` and
  `web/.env.example`, both placeholder-only).
- Real secrets sit only in the **local, untracked `.env`** and (for prod) the
  deploy platform's secret store — never in a tracked file.
- `npm run scan:secrets` scans every git-**tracked** file for live-secret
  patterns and exits non-zero on a hit. Run it before pushing / in CI / as a
  pre-commit hook. (It reads `git ls-files`, so your untracked real `.env` is
  never even opened.)
- `.env.example` documents **every** env var the code reads, with placeholders.

---

## Secret inventory — what each secret feeds

| Secret | Feeds (surface) | Where read | Rotate by |
|--------|-----------------|-----------|-----------|
| `DATABASE_URL` | Postgres/Neon — all persistence | `server/src/db/drizzle.ts` | Neon console → reset the role password → update the deploy secret. |
| `REDIS_URL` | BullMQ queues + scheduler leader lock | `workers/redis.ts`, `scheduler/lock.ts` | Rotate the Redis/Upstash password → update secret. |
| `NYLAS_API_KEY` | Sending + reading email (Nylas) | `providers/nylas/client.ts` | Nylas dashboard → regenerate API key. |
| `NYLAS_GRANT_ID` | The connected mailbox (Nylas OAuth grant) | `providers/nylas/client.ts` | Re-auth the mailbox in Nylas → new grant id. |
| `NYLAS_WEBHOOK_SECRET` | Verifies `X-Nylas-Signature` on inbound `/webhooks/nylas` | `routes/webhooks.ts` | Nylas → recreate the webhook destination → new signing secret (already rotated once this project). |
| `ATTRIBUTION_WEBHOOK_SECRET` | Gates `POST /attribution/conversion` (money integrity — P1) | `routes/attribution.ts` | Generate a new random value; update BOTH this and the Pluvus-side reporter. **Required in prod** (server refuses to boot without it). |
| `OPERATOR_API_KEY` | Gates the operator routes via `X-Operator-Key` (P2) | `middleware/requireOperatorKey.ts` | Generate new; update the deploy secret AND `web`'s `VITE_OPERATOR_API_KEY`. **Required in prod.** |
| `AGENT_API_KEY` | Auth to the Python agent service (`/classify,/negotiate,/draft`) | `adapters/agentServiceClient.ts` | Set the same new value on both the server and the agent service. |
| `OPENROUTER_API_KEY` | Hosted LLM (OpenRouter) — when `LLM_PROVIDER=openrouter` | agent service | openrouter.ai → rotate key. |
| `ANTHROPIC_API_KEY` | Claude direct — when a provider slot = anthropic | agent service | console.anthropic.com → rotate key. |
| `DEEPSEEK_API_KEY` | DeepSeek — when a provider slot = deepseek | agent service | platform.deepseek.com → rotate key. |

**Client-side (public by design):**

| Var | Note |
|-----|------|
| `VITE_OPERATOR_API_KEY` (web) | Compiled INTO the browser bundle — it is **not** a secret from the browser's perspective. This is intentional for the single-operator model (only Pluvus staff load the dashboard). It must equal the server's `OPERATOR_API_KEY`. Do NOT treat it as private; rotate it together with `OPERATOR_API_KEY`. Lives in the gitignored `web/.env.local`. |

Non-secret config (ports, provider selectors, model slugs, timeouts, TTLs,
concurrency, `PAYMENT_BASE_URL`, `LOG_FILE/DIR`, `GMAIL_LABELS_ENABLED`,
`GMAIL_LABEL_PREFIX`, …) is documented in `.env.example` and carries no rotation
concern.

### Gmail Campaign Labels — grant scope prerequisite (feature: gmail-campaign-labels)

`GMAIL_LABELS_ENABLED=true` applies real Gmail labels (`Pluvus/<Campaign name>`)
to conversation threads via the Nylas **Folders** API. This is not a new secret,
but it has a one-time **grant-scope** prerequisite that lives with `NYLAS_GRANT_ID`:

- The connected `NYLAS_GRANT_ID` must be a **Google/Gmail** grant (Nylas Folders ==
  Gmail labels) consented with **Gmail mail-MODIFY scope**
  (`https://www.googleapis.com/auth/gmail.modify`) — send/read-only is not enough
  to create or apply a label.
- If the current grant lacks modify scope, **re-consent the mailbox in Nylas** with
  the modify scope added (produces a new grant id — update `NYLAS_GRANT_ID`).
- Until then, keep `GMAIL_LABELS_ENABLED=false`. With the flag on but the scope
  missing, labeling simply **no-ops with a logged `[labels]` warning** — email
  delivery is never affected — so this is safe to leave off and flip on later.

---

## Rotation runbook

When a secret is (or may be) exposed:

1. **Rotate at the source** (table above) → get the new value.
2. **Update the deploy secret store** (not a committed file) and the local
   `.env`. For `OPERATOR_API_KEY`, also update `web/.env.local`
   `VITE_OPERATOR_API_KEY` and rebuild the web bundle.
3. **Restart** the affected process(es). For `NYLAS_WEBHOOK_SECRET` /
   `PAYMENT_BASE_URL`, also re-register the Nylas webhook (see
   `STABLE_URL.md`).
4. **Verify**: operator routes still 401 without the key and pass with it;
   `/attribution/conversion` still requires `X-Attribution-Secret`;
   `/webhooks/nylas` still verifies.
5. Run `npm run scan:secrets` to confirm nothing leaked into a tracked file.

## Going to prod

- Put all secrets in the deploy platform's secret store; do not ship a `.env`.
- Confirm the P1 boot guard is satisfied (`ATTRIBUTION_WEBHOOK_SECRET` +
  `OPERATOR_API_KEY` set) — the server exits on boot otherwise in
  `NODE_ENV=production`.
- Rotate any secret that was ever shared in plaintext (chat, screenshot, a
  shared `.env`).
