# P3 — Public URL / tunnel runbook

**Goal:** a public origin that serves the creator-facing routes (`/payment`,
`/payout/confirm|dispute`, `/t`) and the Nylas webhook (`/webhooks/nylas`), with
`PAYMENT_BASE_URL` and the Nylas webhook registration pointing at it.

There are two modes. The **interim** (quick tunnel) is what we run today; the
**stable** (named tunnel) is the go-live target once a domain is on Cloudflare.

---

## Why this matters

Links (payment form, payout confirm/dispute, tracking redirect) are minted from
`PAYMENT_BASE_URL` **at send time** and mailed to real creators. The Nylas
webhook is registered against a fixed URL. If the public URL changes and those
two aren't updated, live links 404 and inbound replies stop arriving — disputes
and lost conversions. The quick tunnel's URL **changes on every restart**, which
is exactly the failure this runbook removes.

---

## Interim — quick tunnel (current)

Ephemeral `*.trycloudflare.com` URL, no domain required. The launcher captures
the assigned URL and syncs `PAYMENT_BASE_URL` for you, so a restart never leaves
a stale base URL.

```
# from the repo root, with the API already listening on :3001
node scripts/tunnel.mjs
```

It will:
1. start `npx cloudflared tunnel --url http://localhost:3001`,
2. capture the `https://<random>.trycloudflare.com` URL,
3. write it into `.env` as `PAYMENT_BASE_URL`,
4. print the Nylas webhook URL to (re-)register.

**Every time the URL changes** (i.e. every restart of the tunnel) you must:
- **Re-register the Nylas webhook** against the new `.../webhooks/nylas` (see
  below), and
- **Restart the server** so it reads the new `PAYMENT_BASE_URL` (links are minted
  from `process.env` at send time).

Flags: `--port <n>` (local port, default 3001), `--no-env` (print only, don't
touch `.env`).

> ⚠ This is interim ONLY. The URL still dies on restart — the script just keeps
> `PAYMENT_BASE_URL` honest and reminds you to re-register Nylas. It does NOT
> satisfy P3's "survives restarts" acceptance criterion. Move to a named tunnel
> (or a host deploy) before onboarding creators you can't re-message.

---

## Stable — named Cloudflare tunnel (go-live target)

A named tunnel maps a **fixed hostname** (e.g. `pluvus-app.yourdomain.com`) to
the tunnel, so restarts keep the same URL. **Requires a domain whose nameservers
are on Cloudflare** (a cheap domain is fine; moving an existing domain's NS to
Cloudflare also works).

One-time setup (interactive — run these yourself; they open a browser / need
account auth, so they can't be scripted here):

```
# 1. Authenticate cloudflared to your Cloudflare account (opens a browser).
npx cloudflared tunnel login

# 2. Create a named tunnel (writes a credentials json + a tunnel UUID).
npx cloudflared tunnel create pluvus-app

# 3. Route a DNS hostname on your Cloudflare domain to the tunnel.
npx cloudflared tunnel route dns pluvus-app pluvus-app.yourdomain.com

# 4. Point the tunnel's ingress at the local API. Create a config.yml
#    (default: ~/.cloudflared/config.yml) — do NOT commit it (has the cred path):
#
#      tunnel: <TUNNEL-UUID-from-step-2>
#      credentials-file: C:\Users\<you>\.cloudflared\<UUID>.json
#      ingress:
#        - hostname: pluvus-app.yourdomain.com
#          service: http://localhost:3001
#        - service: http_status:404
```

Then run it (and sync `PAYMENT_BASE_URL` to the stable host) with:

```
node scripts/tunnel.mjs --named pluvus-app.yourdomain.com
```

This sets `PAYMENT_BASE_URL=https://pluvus-app.yourdomain.com` **once** and runs
`cloudflared tunnel run`. Because the hostname is stable, you register the Nylas
webhook **once** and never again on restart.

**Acceptance (P3):** restart server + tunnel → same public URL → existing
payment/payout links still resolve → Nylas webhook still verified, no
re-registration.

---

## Nylas webhook (re-)registration

Register a webhook **destination** pointing at `<PAYMENT_BASE_URL>/webhooks/nylas`
for the message events the engine consumes. Copy the `webhook_secret` Nylas
returns into `.env` `NYLAS_WEBHOOK_SECRET` (it verifies the `X-Nylas-Signature`
on inbound deliveries).

- **Named tunnel:** register once (stable host).
- **Quick tunnel:** re-register every time the URL changes.

Keep `NYLAS_WEBHOOK_SECRET` in `.env` in sync with whatever the current
destination uses, or `/webhooks/nylas` rejects deliveries.

---

## Notes / gotchas

- `cloudflared` here is the npm `cloudflared` package run via `npx` (not a
  PATH install) — that's what `scripts/tunnel.mjs` invokes.
- `PAYMENT_BASE_URL` is read at send time, so a server restart is required after
  it changes.
- Operator routes stay behind `X-Operator-Key` (P2) regardless of the tunnel; a
  future refinement is to expose ONLY the public paths on the tunnel hostname and
  keep operator paths on a protected hostname (Cloudflare Access — the "B" option
  in P2). Out of scope for the interim.
