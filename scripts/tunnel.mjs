#!/usr/bin/env node
// ---------------------------------------------------------------------------
// P3 (interim) — public tunnel launcher that keeps PAYMENT_BASE_URL in sync.
// ---------------------------------------------------------------------------
// The go-live plan wants a STABLE public URL (named Cloudflare tunnel / real
// host) so links + the Nylas webhook survive restarts. Until a domain is on
// Cloudflare, we run the ephemeral `trycloudflare` quick tunnel — whose URL
// CHANGES every restart. The recurring failure (hit 3× in one session) is that
// PAYMENT_BASE_URL then points at a DEAD url → broken payment/payout/tracking
// links + a stale Nylas webhook.
//
// This script removes the manual step: it launches the quick tunnel, captures
// the assigned URL from cloudflared's output, writes it into .env
// PAYMENT_BASE_URL, and prints the exact Nylas webhook URL to (re-)register. So a
// restart is one command and never leaves a stale base URL.
//
// Usage:
//   node scripts/tunnel.mjs                 # quick tunnel → localhost:3001, sync .env
//   node scripts/tunnel.mjs --port 3001     # explicit local port
//   node scripts/tunnel.mjs --no-env        # don't touch .env, just print the URL
//   node scripts/tunnel.mjs --named <host>  # named-tunnel mode (see runbook); sets
//                                           # PAYMENT_BASE_URL=https://<host> and runs
//                                           # `cloudflared tunnel run` (requires the
//                                           # one-time login + create + dns route).
//
// This is the INTERIM. The stable answer is a named tunnel or a host deploy —
// see readme_docs/ops/STABLE_URL.md. Ctrl-C stops the tunnel (the last synced
// PAYMENT_BASE_URL stays in .env until the next run).

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ENV_PATH = join(REPO_ROOT, ".env");

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = flagValue("--port", process.env.PORT || "3001");
const NAMED_HOST = flagValue("--named", null);
const WRITE_ENV = !args.includes("--no-env");

// ---- .env PAYMENT_BASE_URL writer -----------------------------------------
// Rewrite (or append) exactly the PAYMENT_BASE_URL line, preserving everything
// else. Never rewrites the whole file with a template — .env holds live secrets.
function setPaymentBaseUrl(url) {
  if (!WRITE_ENV) {
    console.log(`> (--no-env) would set PAYMENT_BASE_URL=${url}`);
    return;
  }
  if (!existsSync(ENV_PATH)) {
    console.warn(`> WARNING: ${ENV_PATH} not found — not writing PAYMENT_BASE_URL.`);
    return;
  }
  const raw = readFileSync(ENV_PATH, "utf8");
  const line = `PAYMENT_BASE_URL=${url}`;
  const re = /^PAYMENT_BASE_URL=.*$/m;
  const next = re.test(raw)
    ? raw.replace(re, line)
    : raw.replace(/\n?$/, `\n${line}\n`);
  if (next === raw) {
    console.log(`> PAYMENT_BASE_URL already ${url} — no change.`);
    return;
  }
  writeFileSync(ENV_PATH, next);
  console.log(`> .env updated: PAYMENT_BASE_URL=${url}`);
}

function announce(url) {
  setPaymentBaseUrl(url);
  console.log("");
  console.log("  Public base URL : " + url);
  console.log("  Nylas webhook   : " + url + "/webhooks/nylas");
  console.log("");
  console.log("  NEXT: (re)register the Nylas webhook destination against the URL");
  console.log("  above whenever it CHANGES, then RESTART the server so it reads the");
  console.log("  new PAYMENT_BASE_URL (links are minted from it at send time).");
  console.log("");
}

// ---- launch ---------------------------------------------------------------
// The quick tunnel prints its assigned URL to STDERR as
//   |  https://<random>.trycloudflare.com  |
// so we scan both streams for the first trycloudflare URL and sync on it.
const TRYCF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let cfArgs;
if (NAMED_HOST) {
  // Named tunnel: the hostname is stable, so set it up-front and just run the
  // tunnel. The route <host>→this tunnel is configured once (see runbook).
  announce(`https://${NAMED_HOST}`);
  cfArgs = ["cloudflared", "tunnel", "run"];
  console.log(`> starting NAMED tunnel (host ${NAMED_HOST}) …`);
} else {
  cfArgs = ["cloudflared", "tunnel", "--url", `http://localhost:${PORT}`];
  console.log(`> starting QUICK tunnel → http://localhost:${PORT} …`);
  console.log("> (ephemeral URL — will sync PAYMENT_BASE_URL once cloudflared reports it)");
}

// Run via npx so it uses the same cloudflared the operator already has (the
// running one is the npm `cloudflared` package via npx).
const child = spawn("npx", cfArgs, {
  cwd: REPO_ROOT,
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let synced = false;
function scan(buf) {
  const text = buf.toString();
  process.stderr.write(text); // pass cloudflared's own output through
  if (!synced && !NAMED_HOST) {
    const m = text.match(TRYCF_RE);
    if (m) {
      synced = true;
      announce(m[0]);
    }
  }
}
child.stdout.on("data", scan);
child.stderr.on("data", scan);

child.on("exit", (code) => {
  console.log(`> cloudflared exited (code ${code}). PAYMENT_BASE_URL left as last synced.`);
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  console.log("\n> stopping tunnel …");
  child.kill("SIGINT");
});
