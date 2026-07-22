/**
 * Per-executor Gmail-label wiring guard (Gmail Campaign Labels — §6.3).
 * Run with:  npx tsx src/engine/executors/labelCoverage.test.ts
 *
 * Labeling is centralised at ONE seam — the idempotentSend module fires
 * maybeLabelThreadAsync() AFTER the send. There are TWO ways an executor's threads
 * get their campaign label:
 *   1. SYNCHRONOUS sends (outreach/follow-up/content-brief/etc.) pass
 *      ctx.campaign?.name through to sendOnce as the campaignName argument.
 *   2. DEFERRED sends (Randomized Send Delay — the negotiation executor reserves
 *      and defers the flush) can't pass campaignName at reserve time because the
 *      flush runs later in a separate worker with only the messageId. Instead
 *      flushOutbound RELOADS the campaign name from the instance
 *      (resolveCampaignName) and labels at flush — so negotiation threads are still
 *      labeled, just via the reload rather than a call-site pass-through.
 *
 * This test is that structural guard: it asserts every SYNCHRONOUS workflow-driven
 * sending executor passes `ctx.campaign?.name` into sendOnce, that the deferred
 * negotiation path reloads the campaign name at flush, and that the seam fires the
 * labeler after finalize. Source-level (not runtime) on purpose — same rationale as
 * threadingCoverage.test.ts (E8): the invariant is a property of the source and is
 * checked here deterministically and hermetically, without a live DB.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function read(file: string): string {
  return readFileSync(join(here, file), "utf8");
}

// The workflow-driven sending executors that carry a loaded ctx.campaign and so
// MUST pass its name through (spec §6.3). Kept explicit (not globbed) so adding a
// labelable executor is a deliberate edit here. NOTE: route-driven brand-outbound
// sends (payouts.ts / payoutConfirm.ts) deliberately DON'T label in v1 (§6.3) and
// are intentionally absent from this list; partnership/paymentReply/rewardReply
// are likewise out of the §6.3 scope.
// SYNCHRONOUS labeling executors: they send via sendOnce and pass the campaign
// name at the call site. NOTE: negotiation.ts is DELIBERATELY absent — it defers
// its send (Randomized Send Delay), so it labels via the flush-time reload
// asserted separately below, not a call-site pass-through.
const LABELING_EXECUTORS = [
  "initialOutreach.ts",
  "followUp.ts",
  "contentBrief.ts",
  "rewardSetup.ts",
  "paymentInfo.ts",
];

// Strip comments so a doc-comment mentioning campaign?.name isn't a false positive.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// The campaign-name pass-through: ctx.campaign?.name (optionally chained). We look
// for the exact hint the executors thread into sendOnce.
const CAMPAIGN_NAME_PASSTHROUGH = /ctx\.campaign\?\.name/;

async function main() {
  console.log("\nexecutor label-wiring coverage (§6.3)\n");

  for (const file of LABELING_EXECUTORS) {
    test(`${file} passes ctx.campaign?.name into sendOnce()`, () => {
      const src = stripComments(read(file));
      assert.match(
        src,
        CAMPAIGN_NAME_PASSTHROUGH,
        `${file} sends but does not pass ctx.campaign?.name into sendOnce — its ` +
          `threads will go UNLABELED. Thread the campaign name through (spec §6.3).`,
      );
    });
  }

  // The DEFERRED path (Randomized Send Delay): negotiation.ts reserves and defers,
  // so it can't pass campaignName at the call site. Its threads are labeled by
  // flushOutbound reloading the campaign name from the instance. Assert that reload
  // exists in the seam, so a refactor dropping it (which would leave every delayed
  // negotiation thread unlabeled) fails here.
  test("idempotentSend.ts reloads the campaign name at flush for deferred sends (§4.1a)", () => {
    const src = stripComments(read("idempotentSend.ts"));
    assert.match(
      src,
      /resolveCampaignName\s*\(/,
      "flushOutbound must reload the campaign name so DEFERRED negotiation sends " +
        "(which pass no campaignName at reserve time) still get labeled (§4.1a/§6.3).",
    );
  });

  // The seam itself: it must fire the (fire-and-forget) labeler AFTER the send is
  // finalized. Guards against a refactor that drops the label hook or the
  // campaignName parameter.
  test("idempotentSend.ts fires maybeLabelThreadAsync after finalize", () => {
    const src = stripComments(read("idempotentSend.ts"));
    assert.match(
      src,
      /maybeLabelThreadAsync\s*\(/,
      "the send seam must fire maybeLabelThreadAsync so labeling happens post-send",
    );
    assert.match(
      src,
      /campaignName\??\s*:/,
      "the send seam must accept the optional campaignName pass-through param",
    );
  });

  // The label helper must be provider-isolated: it references ONLY the
  // IThreadLabeler guard + the pure campaignLabelName transform — no Nylas type
  // (§6.4). A raw Nylas import in the engine send path would break that isolation.
  test("idempotentSend.ts stays provider-isolated (no Nylas client import)", () => {
    const src = read("idempotentSend.ts");
    assert.ok(
      !/from\s+["'][^"']*nylas\/(client|nylasEmailProvider|mockNylasClient)/.test(src),
      "the engine send path must not import a Nylas client/provider type (§6.4). " +
        "Only isThreadLabeler + campaignLabelName (a pure transform) are allowed.",
    );
    assert.match(src, /isThreadLabeler/, "uses the capability guard, not a concrete provider");
  });

  console.log(`\n✓ executor label-wiring coverage: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
