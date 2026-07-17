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
  // OPERATOR_API_KEY is added by P2 once the operator-route gate lands.
];

/** True when the process considers itself a real deployment (not local/test). */
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return (nodeEnv ?? "").toLowerCase() === "production";
}

/**
 * Pure core: given the environment, return the list of missing required
 * secrets. Empty array ⇒ nothing to complain about. Exported for unit testing
 * without touching the live process.
 *
 * In a NON-production env this always returns [] — dev/harness/test keep their
 * open-when-unset convenience.
 */
export function missingProductionSecrets(
  env: NodeJS.ProcessEnv,
  required: RequiredSecret[] = PRODUCTION_REQUIRED_SECRETS,
): RequiredSecret[] {
  if (!isProductionEnv(env["NODE_ENV"])) return [];
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
