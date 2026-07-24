/**
 * PLU-111 — flushOutbound passes a deferral classifier (built from the SENT body)
 * into updateMessageSent, so the DB resolution can tell answered vs deferred at
 * the moment sentAt is stamped. This proves the §4.5 step-2 wiring at the flush
 * seam without a live DB (the DB resolution itself is covered in the .db test).
 *
 * Run:  npx tsx --test src/engine/executors/flushObligation.test.ts
 */

import assert from "node:assert/strict";
import { flushOutbound, type FlushDeps } from "./idempotentSend.js";
import { isQuestionDeferredBySentBody } from "./commitmentDetection.js";
import type { ConversationObligation } from "../../db/schema.js";
import type { IEmailProvider, EmailSendOptions } from "../providers.js";
import type { EmailDraft } from "../types.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function q(text: string, category?: string): ConversationObligation {
  return {
    id: "q1",
    instanceId: "i1",
    type: "CREATOR_QUESTION",
    status: "OPEN",
    originalText: text,
    normalizedKey: text.toLowerCase(),
    category: category ?? null,
    resolution: null,
    resolutionSource: null,
    sourceMessageId: null,
    resolutionMessageId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    resolvedAt: null,
  };
}

const SENT_BODY = "We'll confirm the usage rights on the next step.";

function makeDeps(captured: { deferred?: boolean | undefined }) {
  const row = {
    id: "m1",
    instanceId: "i1",
    idempotencyKey: "k1",
    subject: "Re: partnership",
    body: SENT_BODY,
    externalMessageId: null as string | null,
    threadId: null as string | null,
  };
  const deps: FlushDeps = {
    async createMessage() {
      return row as never;
    },
    async findMessageByIdempotencyKey() {
      return null;
    },
    async findMessageById() {
      return row as never;
    },
    async updateMessageSent(id, d, deferralClassifier) {
      row.externalMessageId = d.externalMessageId;
      row.threadId = d.threadId;
      // Capture the classifier's verdict on a usage-rights question against the
      // sent body — this is exactly what the DB resolution will consult.
      if (deferralClassifier) {
        captured.deferred = deferralClassifier.isDeferred(q("usage rights?", "usage_rights"));
      } else {
        captured.deferred = undefined;
      }
      return row as never;
    },
    async findInstanceById(id) {
      return { id, creatorId: "c1", workflowVersionId: "wfv1" };
    },
    async findCreatorById(id) {
      return { id, name: "Robin", email: "robin@example.com" } as never;
    },
    async resolveCampaignName() {
      return undefined;
    },
    async acquireSendLock() {
      return "tok";
    },
    async releaseSendLock() {
      /* no-op */
    },
    threadContext: {
      async resolve() {
        return {};
      },
    },
  };
  return deps;
}

function makeEmail(): IEmailProvider {
  return {
    async draft(): Promise<EmailDraft> {
      return { subject: "s", body: SENT_BODY };
    },
    async send(_d, _c, _r, _o?: EmailSendOptions) {
      return { messageId: "ext-1", threadId: "thread-1" };
    },
  };
}

console.log("\nPLU-111 flushOutbound → updateMessageSent classifier wiring\n");

async function main(): Promise<void> {
  await test("flush builds a deferral classifier from the sent body and passes it", async () => {
    const captured: { deferred?: boolean } = {};
    const deps = makeDeps(captured);
    const res = await flushOutbound(makeEmail(), "m1", deps);
    assert.equal(res.skipped, false, "the row was freshly sent");
    // The sent body defers usage rights, so the classifier the flush handed to
    // updateMessageSent must return true for a usage-rights question.
    assert.equal(captured.deferred, true);
    // Sanity: the classifier's verdict matches the pure detector on the same body.
    assert.equal(
      isQuestionDeferredBySentBody(q("usage rights?", "usage_rights"), SENT_BODY),
      true,
    );
  });

  console.log(`\n✓ flushObligation: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
