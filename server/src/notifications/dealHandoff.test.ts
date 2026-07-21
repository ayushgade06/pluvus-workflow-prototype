/**
 * PLU-70 — operator-handoff notifications.
 *
 * These reuse the SAME reserve→send→finalize→audit core as the escalation
 * notice, so the properties worth locking here are the ones specific to the
 * handoff path:
 *   - the finalization email carries the AGREEMENT and deliberately NOT the
 *     transcript (that is the whole reason it is a separate builder),
 *   - a retried delivery returns ALREADY_NOTIFIED and sends nothing, which is
 *     what guarantees the transition + acceptance record are never duplicated,
 *   - a missing DealHandoff row is recorded SKIPPED rather than silently dropped,
 *   - each distinct creator reply forwards exactly once, keyed on message id.
 *
 * In-memory fakes for the DB seam + email provider — no live database. Run with:
 *   npx tsx src/notifications/dealHandoff.test.ts
 */

import assert from "node:assert/strict";
import type { BrandNotification, Creator, DealHandoff } from "../db/schema.js";
import {
  buildDealFinalizationEmail,
  buildHandoffReplyEmail,
  notifyOperatorOfDealFinalization,
  notifyOperatorOfHandoffReply,
  type EscalationDeps,
} from "./escalation.js";
import type { IEmailProvider } from "../engine/providers.js";

let n = 0;
function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(() => {
    n++;
    console.log(`  ✓ ${name}`);
  });
}

const creator = {
  id: "c1",
  name: "Robin Vega",
  email: "robin@creators.test",
  handle: "robinv",
  platform: "YouTube",
  niche: "fitness",
} as unknown as Creator;

const ACCEPTED_AT = new Date("2026-07-20T09:30:00.000Z");

function makeHandoff(overrides: Partial<DealHandoff> = {}): DealHandoff {
  return {
    id: "dh1",
    instanceId: "i1",
    creatorName: creator.name,
    creatorEmail: creator.email,
    campaignName: "Summer Launch",
    fixedFee: 750,
    commissionRate: 30,
    deliverables: "3 IG Reels",
    timeline: "Live by Sept 15",
    paymentTerms: "net-30 after approval",
    acceptanceMessage: "Works for me — let's do it.",
    threadId: "thread-abc",
    acceptedAt: ACCEPTED_AT,
    status: "AWAITING_FINALIZATION",
    completedAt: null,
    completedBy: null,
    createdAt: ACCEPTED_AT,
    updatedAt: ACCEPTED_AT,
    ...overrides,
  } as DealHandoff;
}

function makeDeps(opts?: { notifyEmail?: string | null; handoff?: DealHandoff | null }) {
  const rows = new Map<string, BrandNotification>();
  const events: Array<{ type: string; payload: unknown }> = [];
  const transcriptRequests: Array<boolean | undefined> = [];
  let seq = 0;

  const deps: EscalationDeps = {
    async loadContext(_instanceId: string, loadOpts?: { withTranscript?: boolean }) {
      transcriptRequests.push(loadOpts?.withTranscript);
      return {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: opts?.notifyEmail ?? null,
        // Deliberately NON-empty: if the finalization email ever started
        // rendering the transcript, this would show up in the body assertions.
        transcript: [{ role: "creator", message: "what's the rate?" }] as never,
      };
    },
    async findDealHandoffByInstance() {
      return opts?.handoff === undefined ? makeHandoff() : opts.handoff;
    },
    async createBrandNotification(data: any) {
      const key = data.idempotencyKey as string;
      if (rows.has(key)) {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        throw err;
      }
      const row = {
        id: `bn${++seq}`,
        instanceId: "i1",
        recipient: data.recipient,
        reason: data.reason,
        status: data.status,
        idempotencyKey: key,
        error: null,
        createdAt: new Date(),
      } as unknown as BrandNotification;
      rows.set(key, row);
      return row;
    },
    async findBrandNotificationByKey(key: string) {
      return rows.get(key) ?? null;
    },
    async updateBrandNotificationStatus(id: string, d) {
      const row = [...rows.values()].find((r) => r.id === id)!;
      (row as any).status = d.status;
      (row as any).error = d.error ?? null;
      return row;
    },
    async appendEvent(data: any) {
      events.push({ type: data.type, payload: data.payload });
      return { id: `e${events.length}` } as any;
    },
  };
  return { deps, rows, events, transcriptRequests };
}

function makeEmail(opts?: { throwOnSend?: boolean }) {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const email: IEmailProvider = {
    async draft() {
      return { subject: "", body: "" };
    },
    async send(draft, c, recipient) {
      if (opts?.throwOnSend) throw new Error("smtp unreachable");
      sent.push({
        to: recipient?.email ?? c.email,
        subject: draft.subject,
        body: draft.body,
      });
      return { messageId: `ext-${sent.length}`, threadId: `thread-${sent.length}` };
    },
  };
  return { email, sent };
}

async function main() {
  console.log("\nbuildDealFinalizationEmail\n");

  await test("carries every field an operator needs to finalize the deal", async () => {
    const draft = buildDealFinalizationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
      },
      makeHandoff(),
    );

    assert.equal(draft.subject, "Creator agreement ready for finalization — Robin Vega");
    assert.match(draft.body, /Robin Vega/);
    assert.match(draft.body, /robin@creators\.test/);
    assert.match(draft.body, /Summer Launch/);
    assert.match(draft.body, /\$750 fixed fee \+ 30% commission/);
    assert.match(draft.body, /3 IG Reels/);
    assert.match(draft.body, /Live by Sept 15/);
    assert.match(draft.body, /net-30 after approval/);
    assert.match(draft.body, /2026-07-20T09:30:00\.000Z/);
    assert.match(draft.body, /i1/); // execution reference
    assert.match(draft.body, /Manual Queue/);
  });

  await test("does NOT duplicate the email thread into the notice", async () => {
    const draft = buildDealFinalizationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        // A real conversation is present in context and must still be omitted —
        // the operator opens the inspector when they want it.
        transcript: [{ role: "creator", message: "what's the rate?" }] as never,
      },
      makeHandoff(),
    );
    assert.ok(!/Conversation so far/.test(draft.body));
    assert.ok(!/what's the rate\?/.test(draft.body));
  });

  await test("commission-only deal reads as such, with no fabricated fee", async () => {
    const draft = buildDealFinalizationEmail(
      {
        creator,
        campaignName: "Summer Launch",
        brandName: "Acme Co",
        workflowName: "Summer Outreach",
        notifyEmail: null,
        transcript: [],
      },
      makeHandoff({ fixedFee: null }),
    );
    assert.match(draft.body, /Compensation:\s+30% commission/);
    assert.ok(!/fixed fee/.test(draft.body));
  });

  console.log("\nnotifyOperatorOfDealFinalization\n");

  await test("sends to the campaign contact and records the audit event", async () => {
    const { deps, rows, events } = makeDeps({ notifyEmail: "ops@acme.com" });
    const { email, sent } = makeEmail();

    const res = await notifyOperatorOfDealFinalization(email, "i1", deps);

    assert.equal(res.status, "SENT");
    assert.equal(res.recipient, "ops@acme.com");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "ops@acme.com");
    assert.equal(rows.size, 1);
    assert.equal([...rows.values()][0]!.reason, "needs_deal_finalization");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "BRAND_NOTIFIED");
  });

  await test("skips transcript assembly (the notice never renders it)", async () => {
    const { deps, transcriptRequests } = makeDeps({ notifyEmail: "ops@acme.com" });
    const { email } = makeEmail();
    await notifyOperatorOfDealFinalization(email, "i1", deps);
    assert.deepEqual(transcriptRequests, [false]);
  });

  await test("a retried delivery is ALREADY_NOTIFIED and sends nothing more", async () => {
    // This is the property that keeps the transition + acceptance record
    // single: retrying notification delivery must never re-enter the send path.
    const { deps, rows } = makeDeps({ notifyEmail: "ops@acme.com" });
    const { email, sent } = makeEmail();

    const first = await notifyOperatorOfDealFinalization(email, "i1", deps);
    const second = await notifyOperatorOfDealFinalization(email, "i1", deps);

    assert.equal(first.status, "SENT");
    assert.equal(second.status, "ALREADY_NOTIFIED");
    assert.equal(sent.length, 1, "the operator is emailed exactly once");
    assert.equal(rows.size, 1, "no second notification row");
  });

  await test("a send failure is recorded FAILED and never thrown", async () => {
    // The caller is runtime.stepInstance, AFTER the state commit — a throw here
    // would surface as a worker error on an already-committed transition.
    const { deps, rows } = makeDeps({ notifyEmail: "ops@acme.com" });
    const { email } = makeEmail({ throwOnSend: true });

    const res = await notifyOperatorOfDealFinalization(email, "i1", deps);

    assert.equal(res.status, "FAILED");
    assert.equal([...rows.values()][0]!.status, "FAILED");
    assert.match(String([...rows.values()][0]!.error), /smtp unreachable/);
  });

  await test("a missing DealHandoff row is SKIPPED, not silently dropped", async () => {
    const { deps, rows } = makeDeps({ notifyEmail: "ops@acme.com", handoff: null });
    const { email, sent } = makeEmail();

    const res = await notifyOperatorOfDealFinalization(email, "i1", deps);

    assert.equal(res.status, "SKIPPED");
    assert.equal(sent.length, 0);
    // The gap is still visible in the queue rather than leaving no trace.
    assert.equal(rows.size, 1);
    assert.equal([...rows.values()][0]!.status, "SKIPPED");
  });

  console.log("\nnotifyOperatorOfHandoffReply\n");

  await test("builds a forward that quotes the reply and names the creator", async () => {
    const draft = buildHandoffReplyEmail(
      {
        creator,
        campaignName: null,
        brandName: "Acme Co",
        workflowName: null,
        notifyEmail: null,
        transcript: [],
      },
      { subject: "one more thing", body: "Can we start in October instead?" },
    );
    assert.match(draft.subject, /Robin Vega replied/);
    assert.match(draft.body, /one more thing/);
    assert.match(draft.body, /Can we start in October instead\?/);
    assert.match(draft.body, /robin@creators\.test/);
    // The operator owns this thread now — the copy must not imply the AI will
    // pick it back up.
    assert.match(draft.body, /will NOT respond on its own/);
  });

  await test("forwards through the wired path to the campaign contact", async () => {
    const { deps } = makeDeps({ notifyEmail: "ops@acme.com" });
    const { email, sent } = makeEmail();

    const res = await notifyOperatorOfHandoffReply(
      email,
      "i1",
      {
        externalMessageId: "msg-1",
        subject: "one more thing",
        body: "Can we start in October instead?",
      },
      deps,
    );

    assert.equal(res.status, "SENT");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "ops@acme.com");
    assert.match(sent[0]!.body, /Can we start in October instead\?/);
  });

  await test("each distinct reply forwards once; a retry of the same one does not", async () => {
    const { deps } = makeDeps({ notifyEmail: "ops@acme.com" });
    const { email, sent } = makeEmail();

    const a1 = await notifyOperatorOfHandoffReply(
      email,
      "i1",
      { externalMessageId: "msg-1", subject: "s1", body: "b1" },
      deps,
    );
    // Same message id — a BullMQ redelivery of the same inbound email.
    const a2 = await notifyOperatorOfHandoffReply(
      email,
      "i1",
      { externalMessageId: "msg-1", subject: "s1", body: "b1" },
      deps,
    );
    // A genuinely NEW reply must still get through.
    const b1 = await notifyOperatorOfHandoffReply(
      email,
      "i1",
      { externalMessageId: "msg-2", subject: "s2", body: "b2" },
      deps,
    );

    assert.equal(a1.status, "SENT");
    assert.equal(a2.status, "ALREADY_NOTIFIED");
    assert.equal(b1.status, "SENT");
    assert.equal(sent.length, 2, "two distinct replies, two forwards");
  });

  console.log(`\n${n} passed\n`);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
