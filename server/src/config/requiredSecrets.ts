// ---------------------------------------------------------------------------
// Startup secret guard (P1 / single-operator go-live)
// ---------------------------------------------------------------------------
// Some secrets are OPTIONAL in local dev / harnesses (the code degrades to an
// open posture and logs a one-time warning — same convention as AGENT_API_KEY)
// but MUST be present the moment the process runs as a real, publicly-reachable
// deployment. Running "open" in production is a money-integrity hole:
//   - ATTRIBUTION_WEBHOOK_SECRET unset → anyone can POST fake sales to
//     /attribution/conversion and inflate a creator's commission (we pay it).
//   - OPERATOR_API_KEY unset → the operator money/data routes are ungated on a
//     public origin (see requireOperatorKey / P2).
//
// The per-request checks (attribution.ts checkSecret, requireOperatorKey) keep
// the DEV-friendly open-when-unset behavior. This module is the counterweight:
// at boot, in a production environment, it refuses to start rather than run
// silently open. Fail loud, not silent.

/** A secret that must be set when running in production. */
interface RequiredSecret {
  /** Env var name. */
  name: string;
  /** One-line reason surfaced in the fatal error so the failure is actionable. */
  reason: string;
}

const PRODUCTION_REQUIRED_SECRETS: RequiredSecret[] = [
  {
    name: "ATTRIBUTION_WEBHOOK_SECRET",
    reason:
      "conversion webhook would accept unauthenticated POSTs → attackers can inject " +
      "fake sales and inflate creator commissions (money integrity).",
  },
  {
    name: "OPERATOR_API_KEY",
    reason:
      "operator routes (/payouts, /campaigns, /observability, ...) would be ungated on " +
      "a public origin → anyone who learns the URL can settle money, delete campaigns, " +
      "or read every creator's data.",
  },
];

/** True when the process considers itself a real deployment (not local/test). */
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return (nodeEnv ?? "").toLowerCase() === "production";
}

// ---------------------------------------------------------------------------
// BUG-SEC3: fail-closed-by-default for unset secrets/keys
// ---------------------------------------------------------------------------
// The per-request checks (attribution checkSecret, requireOperatorKey, agent
// auth) historically ran OPEN when their secret was unset, and the boot guard
// only fired on exactly NODE_ENV="production". So a NODE_ENV=staging (or unset)
// public deploy booted WIDE OPEN — anyone who learned the URL could settle money,
// delete campaigns, read all PII, or inject fake conversions.
//
// Inverted: an unset secret is only allowed to run open when we are DEMONSTRABLY
// in local development or test — NODE_ENV is exactly "development" or "test" — OR
// the operator has EXPLICITLY opted into the open posture with
// ALLOW_OPEN_SECRETS=true. Everything else (staging, preview, empty/unset
// NODE_ENV, a typo) fails CLOSED: the check treats a missing secret as "deny".

/** True when NODE_ENV is explicitly a local dev/test environment. */
function isLocalDevOrTest(nodeEnv: string | undefined): boolean {
  const v = (nodeEnv ?? "").toLowerCase();
  return v === "development" || v === "test";
}

/**
 * May an unset secret/key run in the OPEN posture in this environment?
 *
 *  - true  → NODE_ENV is development/test, or ALLOW_OPEN_SECRETS=true → open ok.
 *  - false → any other environment (production, staging, preview, unset, typo)
 *            → an unset secret must FAIL CLOSED, not silently run open.
 *
 * Pure + injectable for unit testing without touching process.env.
 */
export function openPostureAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env["ALLOW_OPEN_SECRETS"] ?? "").toLowerCase() === "true") return true;
  return isLocalDevOrTest(env["NODE_ENV"]);
}

/**
 * Pure core: given the environment, return the list of missing required
 * secrets. Empty array ⇒ nothing to complain about. Exported for unit testing
 * without touching the live process.
 *
 * BUG-SEC3: previously this only reported missing secrets when NODE_ENV was
 * exactly "production" — so a staging/preview/unset-NODE_ENV public deploy booted
 * with the secrets unset and ran WIDE OPEN. Inverted to match the per-request
 * gates: an env that is NOT allowed to run open (i.e. not local dev/test and not
 * ALLOW_OPEN_SECRETS=true) must have every required secret present, or the boot
 * guard refuses to start. Only a demonstrably local dev/test env (or the explicit
 * opt-in) keeps the open-when-unset convenience.
 */
export function missingProductionSecrets(
  env: NodeJS.ProcessEnv,
  required: RequiredSecret[] = PRODUCTION_REQUIRED_SECRETS,
): RequiredSecret[] {
  if (openPostureAllowed(env)) return [];
  return required.filter((s) => {
    const v = env[s.name];
    return v === undefined || v.trim() === "";
  });
}

/**
 * Assert that every production-required secret is present. In production with a
 * missing secret this logs a clear, actionable error and EXITS the process
 * (fail loud) so we never silently boot an open posture. In dev/test it is a
 * no-op. Call once, early, in the API entrypoint.
 */
export function assertRequiredSecrets(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = process.exit,
): void {
  const missing = missingProductionSecrets(env);
  if (missing.length === 0) return;

  console.error(
    "[startup] FATAL: refusing to start in production with missing required secret(s).",
  );
  for (const s of missing) {
    console.error(`  - ${s.name} is unset — ${s.reason}`);
  }
  console.error(
    "[startup] Set the secret(s) in the deploy environment and restart. " +
      "(These are optional only in local dev / NODE_ENV!=production.)",
  );
  exit(1);
}
