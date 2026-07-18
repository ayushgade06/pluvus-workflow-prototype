// ---------------------------------------------------------------------------
// Test-data convention (P8 / single-operator go-live)
// ---------------------------------------------------------------------------
// The dev DB mixes real creator runs with harness fixtures. Going live against
// the same Neon DB means test junk (phase8-harness-* instances, example.com
// creators, the live-test creator) pollutes real operator dashboards and
// metrics. Rather than add an `isTest` column + migration to every table (see
// P8 in the go-live plan — considered and rejected as heavier than needed for a
// single operator), we lean on the ONE thing every harness fixture already
// shares: a recognizable creator EMAIL. All harness/test data hangs off a
// Creator, so "is this row test data?" reduces to "is this creator's email a
// test address?".
//
// This module is the single source of truth for that convention. The cleanup
// script (scripts/cleanHarnessData.ts) uses it to find and delete test rows;
// the same predicate can gate future "hide test data from the dashboard"
// filters. Keep it pure + dependency-free so it is trivially unit-testable and
// safe to import anywhere.

/**
 * Email domains that are, by definition, non-deliverable / reserved for
 * examples and therefore can only be test data (RFC 2606 reserves example.com
 * / .net / .org / .test). Any creator on one of these is a harness fixture.
 */
const RESERVED_TEST_DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
  "example.edu",
  "test",
  "invalid",
  "localhost",
];

/**
 * Exact local-part prefixes the harnesses mint. `phase8-harness-*@example.com`
 * is already covered by the reserved-domain rule above; these catch any test
 * creator that slipped onto a real-looking domain (e.g. the Nylas live-test
 * creator on gmail.com). Extend this list — never widen the domain rule — when
 * a new named test creator is introduced, so a real creator can never be
 * matched by accident.
 */
const KNOWN_TEST_EMAILS = new Set<string>([
  // The Phase 6 Nylas live-test creator (setup-live-test.ts). A real gmail
  // address used ONLY for end-to-end inbox testing, never a paying partner.
  "ayushgade23@gmail.com",
]);

/**
 * Local-part markers that unambiguously denote a test address regardless of
 * domain (e.g. `harness+run3@somedomain.com`). Deliberately conservative: only
 * substrings a real creator would never carry.
 */
const TEST_LOCALPART_MARKERS = ["+harness", "phase8-harness", "harness-creator"];

/** Lower-case + trim an email for stable comparison. */
function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True when an email belongs to the harness/test convention and its owning rows
 * are safe to purge from a production database. Pure — no I/O — so the cleanup
 * script and any dashboard filter share ONE definition of "test data".
 *
 * Matching is intentionally strict: a real creator's address must NEVER return
 * true, because the cleanup script deletes everything hanging off a matched
 * creator (instances, messages, events, partnerships, the whole payout ledger).
 * When in doubt, do NOT match.
 */
export function isTestEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = normalize(email);
  if (KNOWN_TEST_EMAILS.has(e)) return true;

  const atIndex = e.lastIndexOf("@");
  if (atIndex === -1) return false; // not an address shape → don't touch it
  const localPart = e.slice(0, atIndex);
  const domain = e.slice(atIndex + 1);

  if (RESERVED_TEST_DOMAINS.includes(domain)) return true;
  // A reserved suffix like `foo.test` / `bar.example` also counts.
  if (RESERVED_TEST_DOMAINS.some((d) => domain.endsWith(`.${d}`))) return true;

  return TEST_LOCALPART_MARKERS.some((m) => localPart.includes(m));
}

/**
 * The reserved test domains + known emails, exported for docs / diagnostics
 * (the cleanup script prints the convention so an operator can eyeball it before
 * a destructive run).
 */
export const TEST_DATA_CONVENTION = {
  reservedDomains: RESERVED_TEST_DOMAINS,
  knownEmails: [...KNOWN_TEST_EMAILS],
  localPartMarkers: TEST_LOCALPART_MARKERS,
} as const;
