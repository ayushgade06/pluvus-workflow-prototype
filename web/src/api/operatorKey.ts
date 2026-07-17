// ---------------------------------------------------------------------------
// P2 — operator key injection (web dashboard)
// ---------------------------------------------------------------------------
// The dashboard talks to the operator routes (/campaigns, /payouts,
// /observability, ...), which the server gates behind X-Operator-Key (see
// server middleware/requireOperatorKey.ts). The key is injected at build/dev
// time via VITE_OPERATOR_API_KEY (web/.env.local, gitignored). When unset (local
// dev against an ungated server) no header is sent — the server is open-when-
// unset there too, so nothing breaks.
//
// This is a shared secret embedded in the browser bundle, which is fine for the
// single-operator model (only Pluvus loads this dashboard); it is NOT per-user
// auth and must not be treated as one.

// Vite replaces import.meta.env at build/dev time. Guard the access so this
// module also loads under a plain (non-Vite) runtime like `tsx` running the unit
// tests, where import.meta.env is undefined — otherwise the whole client module
// throws at import time.
const OPERATOR_KEY: string | undefined = import.meta.env?.VITE_OPERATOR_API_KEY;

/**
 * Headers carrying the operator key, or {} when unset. Spread into any fetch to
 * an operator route:  fetch(url, { headers: { ...operatorHeaders(), ... } })
 */
export function operatorHeaders(): Record<string, string> {
  return OPERATOR_KEY ? { "X-Operator-Key": OPERATOR_KEY } : {};
}

/**
 * Merge the operator key into an existing RequestInit's headers without clobbering
 * caller-supplied headers (e.g. Content-Type). Header init may be a plain object,
 * a Headers instance, or an array of tuples — normalize to a plain object.
 */
export function withOperatorKey(init?: RequestInit): RequestInit {
  const merged = new Headers(init?.headers);
  const key = operatorHeaders()["X-Operator-Key"];
  if (key) merged.set("X-Operator-Key", key);
  return { ...init, headers: merged };
}
