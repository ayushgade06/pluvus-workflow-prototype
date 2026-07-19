/**
 * Unit tests for Phase 1 partnership logic.
 * Pure — no DB, no Express.  Run:
 *   npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrackingLink } from "./partnership.js";
import { blockedByAttributionMint } from "./guardEscalation.js";
import { renderPartnershipWelcomeEmail } from "./partnershipWelcomeEmail.js";
import { generateReferralCode } from "../../db/partnerships.js";
import { isUniqueViolation } from "../../db/errors.js";
import { assertTransition } from "../stateMachine.js";

// ---------------------------------------------------------------------------
// Referral code shape
// ---------------------------------------------------------------------------

describe("generateReferralCode", () => {
  it("produces slug_hex format", () => {
    const code = generateReferralCode("Casey Creator");
    assert.match(code, /^[a-z0-9]{1,12}_[0-9a-f]{12}$/);
  });

  it("strips non-alphanumeric characters from the slug", () => {
    const code = generateReferralCode("Léa O'Brien!");
    const [slug] = code.split("_");
    assert.match(slug!, /^[a-z0-9]+$/);
  });

  it("truncates slug to 12 characters", () => {
    const code = generateReferralCode("averylongcreatorname");
    const [slug] = code.split("_");
    assert.ok(slug!.length <= 12);
  });

  it("produces different codes on successive calls (collision retry would work)", () => {
    const a = generateReferralCode("Ada");
    const b = generateReferralCode("Ada");
    // Hex suffix is random — these should differ with overwhelming probability.
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Tracking link construction
// ---------------------------------------------------------------------------

describe("buildTrackingLink", () => {
  it("returns null when targetUrl is null", () => {
    assert.equal(buildTrackingLink(null, "_from", "ada_abc123"), null);
  });

  it("returns null when targetUrl is undefined", () => {
    assert.equal(buildTrackingLink(undefined, "_from", "ada_abc123"), null);
  });

  it("returns null when targetUrl is empty string", () => {
    assert.equal(buildTrackingLink("", "_from", "ada_abc123"), null);
  });

  it("appends the referral code as the hidden param", () => {
    const link = buildTrackingLink("https://example.com/shop", "_from", "ada_abc123");
    assert.equal(link, "https://example.com/shop?_from=ada_abc123");
  });

  it("preserves existing query-string params", () => {
    const link = buildTrackingLink(
      "https://example.com/shop?utm_source=ig",
      "_from",
      "ada_abc123",
    );
    assert.ok(link!.includes("utm_source=ig"));
    assert.ok(link!.includes("_from=ada_abc123"));
  });

  it("uses a custom hiddenParamKey", () => {
    const link = buildTrackingLink("https://example.com", "ref", "ada_abc123");
    assert.ok(link!.includes("ref=ada_abc123"));
    assert.ok(!link!.includes("_from"));
  });

  it("returns null for an invalid URL", () => {
    const link = buildTrackingLink("not-a-url", "_from", "ada_abc123");
    assert.equal(link, null);
  });

  // BUG-SEC5 defense-in-depth: a non-http(s) scheme must never yield a
  // trackingLink (which the /t redirect would 302 to).
  it("returns null for a javascript: scheme", () => {
    assert.equal(buildTrackingLink("javascript:alert(1)", "_from", "ada_abc123"), null);
  });

  it("returns null for a data: scheme", () => {
    assert.equal(
      buildTrackingLink("data:text/html,<script>1</script>", "_from", "ada_abc123"),
      null,
    );
  });

  it("returns null for a file: scheme", () => {
    assert.equal(buildTrackingLink("file:///etc/passwd", "_from", "ada_abc123"), null);
  });
});

// ---------------------------------------------------------------------------
// resolvePartnership: idempotency and money-term resolution are tested in
// the harness (requires DB). Here we test the collision-retry logic shape
// by asserting isUniqueViolation correctly identifies 23505 errors.
// ---------------------------------------------------------------------------

describe("isUniqueViolation", () => {
  it("recognises a Postgres 23505 error object", () => {
    const err = Object.assign(new Error("dup"), { code: "23505" });
    assert.ok(isUniqueViolation(err));
  });

  it("returns false for a non-unique error", () => {
    const err = Object.assign(new Error("other"), { code: "23502" });
    assert.ok(!isUniqueViolation(err));
  });

  it("returns false for a plain Error with no code", () => {
    assert.ok(!isUniqueViolation(new Error("plain")));
  });
});

// ---------------------------------------------------------------------------
// BUG-E2: a failed attribution/obligation mint on the payout-form submission
// must escalate to MANUAL_REVIEW rather than "complete" the deal. The full
// executor path (executeContentBriefSubmission / executePaymentSubmission) is
// DB-backed and lives in the harnesses; here we lock the decision helper's
// contract — the shape both executors return when resolvePartnership yields no
// partnership — since a regression that made this terminal-success would silently
// lose a creator's money ledger with no recovery path.
// ---------------------------------------------------------------------------

describe("BUG-E2: blockedByAttributionMint (mint-failure escalation)", () => {
  const result = blockedByAttributionMint("CONTENT_BRIEF");

  it("routes to MANUAL_REVIEW, never a success terminal", () => {
    assert.equal(result.nextState, "MANUAL_REVIEW");
    // Guard against the exact regression: it must NOT be the success terminal.
    assert.notEqual(result.nextState, "CONTENT_BRIEF_SENT");
    assert.notEqual(result.nextState, "PAYMENT_RECEIVED");
  });

  it("PAYMENT_PENDING → MANUAL_REVIEW is a legal transition (both submission executors enter from PAYMENT_PENDING)", () => {
    assert.doesNotThrow(() => assertTransition("PAYMENT_PENDING", "MANUAL_REVIEW"));
  });

  it("records an auditable escalation reason for the manual queue", () => {
    const payload = result.eventPayload as Record<string, unknown>;
    assert.equal(result.eventType, "MANUAL_REVIEW_FLAGGED");
    assert.equal(payload["outcome"], "ESCALATE");
    assert.equal(payload["reason"], "attribution_mint_failed");
    assert.equal(payload["node"], "CONTENT_BRIEF");
  });

  it("stamps completedAt (terminal handoff into the manual queue)", () => {
    assert.ok(result.completedAt instanceof Date);
    assert.equal(result.nextNodeId, null);
  });
});

// ---------------------------------------------------------------------------
// Welcome email template
// ---------------------------------------------------------------------------

describe("renderPartnershipWelcomeEmail – link variant", () => {
  const result = renderPartnershipWelcomeEmail({
    creatorName: "Casey",
    brandName: "Acme",
    senderName: "Acme Partnerships",
    trackingLink: "https://example.com/shop?_from=casey_abc123",
    agreedFeeCents: 42000,
    commissionRate: 15,
  });

  it("uses the link-variant subject", () => {
    assert.equal(result.subject, "You're all set — here's your tracking link");
  });

  it("body includes the tracking link", () => {
    assert.ok(result.body.includes("https://example.com/shop?_from=casey_abc123"));
  });

  it("body includes the fee in dollars (cents → dollars)", () => {
    // 42000 cents = $420
    assert.ok(result.body.includes("$420"));
  });

  it("body includes the commission rate", () => {
    assert.ok(result.body.includes("15%"));
  });

  it("body greets the creator by name", () => {
    assert.ok(result.body.includes("Casey"));
  });

  it("body mentions the brand", () => {
    assert.ok(result.body.includes("Acme"));
  });

  it("is signed by the sender", () => {
    assert.ok(result.body.includes("Acme Partnerships"));
  });
});

describe("renderPartnershipWelcomeEmail – no-link variant", () => {
  const result = renderPartnershipWelcomeEmail({
    creatorName: "Jordan",
    brandName: "BrandX",
    senderName: "BrandX Team",
    trackingLink: null,
    agreedFeeCents: 15000,
  });

  it("uses the no-link subject", () => {
    assert.equal(result.subject, "You're all set — next steps for your collaboration");
  });

  it("body does NOT include a tracking link section", () => {
    assert.ok(!result.body.includes("tracking link"));
  });

  it("body includes the fee in dollars", () => {
    // 15000 cents = $150
    assert.ok(result.body.includes("$150"));
  });
});

describe("renderPartnershipWelcomeEmail – cents rounding", () => {
  it("Math.round(14999.5 * 100) rounds correctly", () => {
    // agreedFeeCents is already integer cents — just rendering it as dollars.
    // Test the documented rule: agreedFeeCents = Math.round(fixedFee * 100).
    // 149.995 * 100 = 14999.5 → Math.round = 15000.
    assert.equal(Math.round(149.995 * 100), 15000);
  });

  it("renders a whole-dollar amount without trailing .00", () => {
    const { body } = renderPartnershipWelcomeEmail({
      creatorName: "X",
      brandName: "B",
      senderName: "B",
      agreedFeeCents: 50000,
    });
    assert.ok(body.includes("$500"), "expected $500");
    assert.ok(!body.includes("$500.00"), "should not show .00 for whole dollars");
  });

  it("renders a fractional-dollar amount with cents", () => {
    const { body } = renderPartnershipWelcomeEmail({
      creatorName: "X",
      brandName: "B",
      senderName: "B",
      agreedFeeCents: 50050,
    });
    assert.ok(body.includes("$500.50"), "expected $500.50");
  });
});

describe("renderPartnershipWelcomeEmail – commission-only variant", () => {
  it("shows commission only when no agreedFeeCents", () => {
    const { body } = renderPartnershipWelcomeEmail({
      creatorName: "X",
      brandName: "B",
      senderName: "B",
      commissionRate: 10,
    });
    assert.ok(body.includes("10%"));
    assert.ok(!body.includes("Fixed fee"));
  });
});
