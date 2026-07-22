/**
 * Per-executor threading regression guard (Email Threading — E8).
 * Run with:  npx tsx src/engine/executors/threadingCoverage.test.ts
 *
 * Threading is centralised at ONE seam — the idempotentSend module (ADR-1). Every
 * executor that emails a creator therefore inherits threading FOR FREE by routing
 * its send through that seam; the integration test proves the seam itself threads.
 * The one way threading can silently regress is a NEW (or edited) executor that
 * emails WITHOUT going through the seam.
 *
 * Randomized Send Delay note: the seam has TWO entry points now — sendOnce() (the
 * synchronous reserve→flush wrapper, used by outreach/follow-up/transactional
 * sends) and reserveOutbound() (the reserve half, used by the negotiation executor
 * which defers the flush). Both resolve the SAME thread context and derive the
 * SAME reply subject, so an executor that routes through EITHER inherits threading.
 *
 * This test is that structural guard: it asserts (a) every executor known to send
 * routes through the seam (sendOnce OR reserveOutbound), and (b) no executor calls
 * a raw email transport (email.send / provider.send / client.messages.send)
 * directly, which would skip threading. If someone adds a send site that bypasses
 * the seam, this fails and points them back at it.
 *
 * Source-level (not runtime) on purpose: spinning up all ~10 executors against a
 * live DB would duplicate each executor's own suite and depend on DB availability;
 * the invariant we need to protect ("all sends flow through the one seam") is a
 * property of the source, and is checked here deterministically and hermetically.
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

// Every executor that sends a creator-facing email. Kept explicit (not globbed)
// so ADDING a sending executor is a deliberate edit here — the checklist is the
// point. Mirrors the RFC E8 per-executor list.
const SENDING_EXECUTORS = [
  "initialOutreach.ts",
  "followUp.ts",
  "negotiation.ts", // accept / counter / present-offer / close
  "contentBrief.ts",
  "partnership.ts",
  "paymentInfo.ts",
  "paymentReply.ts",
  "rewardSetup.ts",
  "rewardReply.ts",
];

// A "real" call to a raw transport that would BYPASS the seam. We strip line and
// block comments first so a doc-comment mentioning email.send() (e.g. the header
// note in negotiation.ts) is not a false positive.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (leave URLs' `://` intact)
}

const RAW_TRANSPORT = /\b(?:email|provider)\.send\s*\(|\.messages\.send\s*\(/;

async function main() {
  console.log("\nexecutor threading coverage (E8)\n");

  // The seam has two entry points (see header): the synchronous sendOnce wrapper
  // and the reserveOutbound reserve-half (negotiation defers its flush). Either
  // routes through the same thread-context resolve + reply-subject derivation.
  const SEAM_ENTRY = /\b(?:sendOnce|reserveOutbound|reserveAiReply)\s*\(/;

  for (const file of SENDING_EXECUTORS) {
    test(`${file} routes its send through the idempotentSend seam`, () => {
      const src = read(file);
      assert.match(
        src,
        SEAM_ENTRY,
        `${file} must send via sendOnce() or reserveOutbound() so it inherits ` +
          `threading (ADR-1). If it now sends a different way, wire it through the seam.`,
      );
    });

    test(`${file} does NOT call a raw email transport directly (would bypass threading)`, () => {
      const src = stripComments(read(file));
      assert.ok(
        !RAW_TRANSPORT.test(src),
        `${file} calls a raw transport (email.send/provider.send/messages.send) ` +
          `directly — that bypasses the threading seam. Route it through sendOnce().`,
      );
    });
  }

  // sendOnce itself is the seam: it MUST pass options to email.send() so the
  // provider can thread. Guards against a refactor that drops the options arg.
  test("idempotentSend.ts passes threading options to email.send()", () => {
    const src = read("idempotentSend.ts");
    assert.match(src, /buildReplySubject\s*\(/, "sendOnce derives the reply subject");
    assert.match(src, /threadContext\.resolve\s*\(/, "sendOnce resolves thread context");
    // options passed on the send call(s).
    assert.match(src, /email\.send\([\s\S]*?options[\s\S]*?\)/, "sendOnce passes options to email.send()");
  });

  console.log(`\n✓ executor threading coverage: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
