import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { openPostureAllowed } from "../config/requiredSecrets.js";

// ---------------------------------------------------------------------------
// P2 — operator-route gate (single-operator go-live)
// ---------------------------------------------------------------------------
// Pluvus is the SOLE operator. Creators only ever touch the system through email
// magic-links (/payment, /payout/confirm|dispute) and webhooks (/webhooks, /t,
// /attribution) — never the operator money/data routes. But everything runs on
// ONE public Express origin, so "we're the only users" does NOT protect the
// operator routes if the URL is known. This middleware gates them with a shared
// secret: callers (the web dashboard) must send X-Operator-Key matching
// OPERATOR_API_KEY. Mounted on the operator routers ONLY (see app.ts); the
// creator/webhook routers stay open.
//
// Convention mirrors attribution.ts checkSecret + queues.ts requireInjection
// Enabled: open-when-unset in local dev (a one-time warning), but the startup
// guard (config/requiredSecrets.ts) refuses to boot in production if the key is
// unset — so we never silently run the operator surface open in prod.

let _warnedMissingKey = false;

/**
 * Pure predicate: does the request carry a valid operator key?
 *
 *  - key unset/blank  → OPEN (dev convenience). Returns "open".
 *  - header missing    → "missing".
 *  - header mismatch   → "invalid".
 *  - header matches     → "ok".
 *
 * Constant-time compare on the match path (no early-exit length leak beyond the
 * unavoidable length check, same as the attribution/agent secret checks).
 * Exported for unit testing without an HTTP round-trip.
 */
export function checkOperatorKey(
  configuredKey: string | undefined,
  providedHeader: unknown,
): "open" | "missing" | "invalid" | "ok" {
  const key = (configuredKey ?? "").trim();
  if (key === "") return "open";

  if (typeof providedHeader !== "string" || providedHeader === "") return "missing";

  try {
    const a = Buffer.from(key, "utf8");
    const b = Buffer.from(providedHeader, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "invalid";
  } catch {
    return "invalid";
  }
  return "ok";
}

/**
 * Express middleware form. Reads OPERATOR_API_KEY from the environment at request
 * time (so tests / a hot reload see the current value) and X-Operator-Key from
 * the request. 401 on missing/invalid; passes through on ok or an unset key.
 */
export const requireOperatorKey: RequestHandler = (req, res, next) => {
  const verdict = checkOperatorKey(
    process.env["OPERATOR_API_KEY"],
    req.headers["x-operator-key"],
  );

  if (verdict === "open") {
    // BUG-SEC3: an unset key is only allowed to run OPEN in local dev/test (or
    // with an explicit ALLOW_OPEN_SECRETS=true opt-in). Anywhere else — staging,
    // preview, unset/typo'd NODE_ENV — fail CLOSED so a mis-set env can never boot
    // the operator surface wide open. (The boot guard also refuses to start in
    // production; this covers the non-"production" public deploys it misses.)
    if (!openPostureAllowed()) {
      res.status(401).json({ error: "Operator authentication is not configured" });
      return;
    }
    if (!_warnedMissingKey) {
      console.warn(
        "[operator-gate] OPERATOR_API_KEY is not set — operator routes accept " +
          "unauthenticated requests. This is allowed only because NODE_ENV is " +
          "development/test or ALLOW_OPEN_SECRETS=true. Set the key in any exposed " +
          "environment (the server also refuses to boot without it in production).",
      );
      _warnedMissingKey = true;
    }
    next();
    return;
  }

  if (verdict === "missing") {
    res.status(401).json({ error: "Missing X-Operator-Key header" });
    return;
  }
  if (verdict === "invalid") {
    res.status(401).json({ error: "Invalid operator key" });
    return;
  }
  next();
};
