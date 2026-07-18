#!/usr/bin/env node
// ---------------------------------------------------------------------------
// add-conversion — record a purchase (conversion) for a partner
// ---------------------------------------------------------------------------
// Resolves a partner (by referral code, email, name, or partnership id), then
// POSTs a conversion to the running server's /attribution/conversion webhook —
// exactly what Pluvus's outbound reporter will do in production when a referred
// user buys. Prints the before/after commission owed so you can see it accrue.
//
// Uses only Node built-ins (fetch/FormData). No deps, no DB access — everything
// goes through the server's REST API so the same validation + commission math
// applies.
//
// Usage:
//   node .claude/skills/add-conversion/scripts/add-conversion.mjs --partner <who> --amount <dollars> [opts]
//
//   --partner   <str>   referral code, creator email, creator name, or partnership id (required)
//   --amount    <num>   sale value in DOLLARS (e.g. 149 or 149.99). Mutually exclusive with --amount-cents
//   --amount-cents <n>  sale value in integer CENTS (e.g. 14900)
//   --external-id <str> unique sale id (dedup key). Default: auto-generated
//   --email     <str>   customer email (optional)
//   --currency  <str>   default USD
//   --refund            refund an existing conversion by --external-id instead of creating one
//
// Env:
//   PORT (default 3001), SERVER (overrides full base URL)
//   OPERATOR_API_KEY        — sent as X-Operator-Key to read /partnerships (auto-read from .env)
//   ATTRIBUTION_WEBHOOK_SECRET — sent as X-Attribution-Secret to /attribution (auto-read from .env)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ── args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const flag = (name) => args.includes(`--${name}`);

const partnerRef = opt("partner");
const amountDollars = opt("amount");
const amountCentsArg = opt("amount-cents");
const externalId = opt("external-id") ?? `manual-${randomUUID()}`;
const customerEmail = opt("email");
const currency = opt("currency") ?? "USD";
const isRefund = flag("refund");

const PORT = process.env.PORT || "3001";
const BASE = process.env.SERVER || `http://localhost:${PORT}`;

// ── load secrets from .env (best-effort; env vars win) ─────────────────────
function readEnvFile() {
  const out = {};
  for (const p of [".env", "server/.env"]) {
    try {
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "").trim();
      }
    } catch {
      /* file may not exist */
    }
  }
  return out;
}
const envFile = readEnvFile();
const OPERATOR_KEY = process.env.OPERATOR_API_KEY || envFile.OPERATOR_API_KEY || "";
const ATTR_SECRET =
  process.env.ATTRIBUTION_WEBHOOK_SECRET || envFile.ATTRIBUTION_WEBHOOK_SECRET || "";

// ── http helpers ───────────────────────────────────────────────────────────
async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}
async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// ── resolve the partner → { referralCode, id, rollup } ─────────────────────
async function resolvePartner(ref) {
  const list = await get("/partnerships", OPERATOR_KEY ? { "X-Operator-Key": OPERATOR_KEY } : {});
  const items = Array.isArray(list) ? list : list.items ?? [];
  const needle = ref.toLowerCase();
  const match = items.find(
    (p) =>
      p.referralCode?.toLowerCase() === needle ||
      p.id?.toLowerCase() === needle ||
      p.creatorEmail?.toLowerCase() === needle ||
      p.creatorName?.toLowerCase() === needle,
  );
  if (!match) {
    const known = items
      .map((p) => `  ${p.creatorName} <${p.creatorEmail}> code=${p.referralCode}`)
      .join("\n");
    throw new Error(
      `No partner matched "${ref}". Known partners:\n${known || "  (none — is a hybrid run onboarded?)"}`,
    );
  }
  return match;
}

function fmt(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!partnerRef) throw new Error("--partner is required (referral code, email, name, or id)");

  console.log(`> Server ${BASE}`);
  const partner = await resolvePartner(partnerRef);
  console.log(
    `> Partner: ${partner.creatorName} <${partner.creatorEmail}> | code=${partner.referralCode} | commission ${partner.commissionRate ?? 0}%`,
  );
  const before = partner.rollup ?? {};
  console.log(
    `> Before: unpaid commission ${fmt(before.unpaidCommissionCents ?? 0)} | conversions ${partner.metrics?.conversions ?? 0}`,
  );

  const attrHeaders = ATTR_SECRET ? { "X-Attribution-Secret": ATTR_SECRET } : {};

  if (isRefund) {
    const { status, json } = await post(
      `/attribution/conversion/${encodeURIComponent(externalId)}/refund`,
      {},
      attrHeaders,
    );
    console.log(`> Refund externalId=${externalId} -> HTTP ${status}: ${JSON.stringify(json)}`);
    if (status >= 400) process.exit(1);
  } else {
    // amount resolution
    const body = {
      referralCode: partner.referralCode,
      externalId,
      currency,
      ...(customerEmail ? { customerEmail } : {}),
      metadata: { kind: "purchase", source: "manual-skill" },
    };
    if (amountCentsArg !== undefined) {
      body.amountCents = Number(amountCentsArg);
    } else if (amountDollars !== undefined) {
      body.amount = Number(amountDollars);
    } else {
      throw new Error("Provide --amount <dollars> or --amount-cents <n>");
    }

    const { status, json } = await post("/attribution/conversion", body, attrHeaders);
    console.log(
      `> Conversion externalId=${externalId} amount=${body.amountCents ?? body.amount}${
        body.amountCents ? " cents" : " dollars"
      } -> HTTP ${status}: ${JSON.stringify(json)}`,
    );
    if (status >= 400) {
      console.error("  (401 => set ATTRIBUTION_WEBHOOK_SECRET; 400 => check amount/fields)");
      process.exit(1);
    }
  }

  // re-read rollup to show the effect
  const after = await resolvePartner(partner.referralCode);
  const r = after.rollup ?? {};
  console.log(
    `> After:  unpaid commission ${fmt(r.unpaidCommissionCents ?? 0)} | conversions ${after.metrics?.conversions ?? 0} | revenue ${fmt(after.metrics?.revenueCents ?? 0)}`,
  );
  console.log("Done.");
}

main().catch((err) => {
  console.error(`\nadd-conversion failed: ${err.message}`);
  process.exit(1);
});
