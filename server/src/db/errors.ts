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

export function isUniqueViolation(err: unknown): boolean {
  const codes = ["23505", "P2002"];
  const direct = codeOf(err);
  if (direct !== undefined && codes.includes(direct)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  const nested = codeOf(cause);
  return nested !== undefined && codes.includes(nested);
}
