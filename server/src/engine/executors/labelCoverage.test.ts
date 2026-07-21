/**
 * Per-executor Gmail-label wiring guard (Gmail Campaign Labels — §6.3).
 * Run with:  npx tsx src/engine/executors/labelCoverage.test.ts
 *
 * Labeling is centralised at ONE seam — sendOnce() fires maybeLabelThreadAsync()
 * AFTER the send (idempotentSend.ts). An executor opts its threads into a campaign
 * label by passing ctx.campaign?.name through to sendOnce as the campaignName
 * argument. The one way this silently regresses is an executor that sends but
 * forgets to pass the campaign name — its threads then go unlabeled.
 *
 * This test is that structural guard: it asserts every WORKFLOW-DRIVEN sending
 * executor in the spec's §6.3 list passes `ctx.campaign?.name` into sendOnce, and
 * that sendOnce actually fires the labeler after finalize. Source-level (not
 * runtime) on purpose — same rationale as threadingCoverage.test.ts (E8): the
 * invariant is a property of the source and is checked here deterministically and
 * hermetically, without a live DB or all ~10 executors spun up.
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
const LABELING_EXECUTORS = [
  "initialOutreach.ts",
  "followUp.ts",
  "negotiation.ts", // accept / counter / present-offer / close
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

  // The seam itself: sendOnce must fire the (fire-and-forget) labeler AFTER the
  // send is finalized. Guards against a refactor that drops the label hook or the
  // campaignName parameter.
  test("idempotentSend.ts fires maybeLabelThreadAsync after finalize", () => {
    const src = stripComments(read("idempotentSend.ts"));
    assert.match(
      src,
      /maybeLabelThreadAsync\s*\(/,
      "sendOnce must fire maybeLabelThreadAsync so labeling happens post-send",
    );
    assert.match(
      src,
      /campaignName\??\s*:/,
      "sendOnce must accept the optional campaignName pass-through param",
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
