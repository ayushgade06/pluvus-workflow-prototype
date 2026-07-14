// Database error classification helpers.
//
// The Prisma port left call sites (idempotentSend, escalation notifier, …)
// branching on Prisma's error codes. Under Drizzle the driver surfaces raw
// Postgres SQLSTATE codes instead. This helper accepts BOTH:
//   - "23505"  — Postgres unique_violation (what pg/neon-serverless throws)
//   - "P2002"  — Prisma's unique-constraint code, still thrown by the
//                in-memory fakes in the test suite's dependency-injection
//                seams (they simulate the db layer's contract, and that
//                contract predates the Drizzle port)
// Drizzle may wrap the driver error, so `cause` is checked too.

function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function hasCode(err: unknown, codes: string[]): boolean {
  const direct = codeOf(err);
  if (direct !== undefined && codes.includes(direct)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  const nested = codeOf(cause);
  return nested !== undefined && codes.includes(nested);
}

export function isUniqueViolation(err: unknown): boolean {
  return hasCode(err, ["23505", "P2002"]);
}

/**
 * Postgres foreign_key_violation (23503). Under Prisma the same situation
 * surfaced as P2003, or P2025 when a nested `connect` pointed at a missing
 * row — all three mean "the referenced record does not exist".
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasCode(err, ["23503", "P2003", "P2025"]);
}
