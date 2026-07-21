/**
 * Unit tests for the shared idempotent outbound send (FIX-11 generalized).
 * In-memory fakes for the DB seam + email provider — no live database.
 * Run with:  npx tsx src/engine/executors/idempotentSend.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "../../db/schema.js";
import { sendOnce, type SendOnceDeps } from "./idempotentSend.js";
import type { IEmailProvider, EmailSendOptions } from "../providers.js";
import type { ThreadContext } from "../threadContext.js";
import type { EmailDraft } from "../types.js";

let n = 0;
function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(() => {
    n++;
    console.log(`  ✓ ${name}`);
  });
}

const creator = { id: "c1", name: "Robin" } as unknown as Creator;
const draft: EmailDraft = { subject: "Hi", body: "Let's collaborate." };

// A fake "messages table" keyed by idempotencyKey, enforcing the unique
// constraint the real DB provides (throws a P2002-shaped error on duplicate).
// `ctx` seeds the injected thread-context resolver; it defaults to empty (a
// first outbound), preserving every existing test's behaviour.
// `throwOnResolve` (E7) makes the resolver throw so we can assert sendOnce
// degrades to a new-thread send rather than blocking delivery.
function makeDeps(ctx: ThreadContext = {}, opts?: { throwOnResolve?: boolean }) {
  const rows = new Map<string, any>();
  let seq = 0;
  let resolves = 0;
  const deps: SendOnceDeps = {
    async createMessage(data: any) {
      const key = data.idempotencyKey as string;
      if (rows.has(key)) {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        throw err;
      }
      const row = {
        id: `m${++seq}`,
        idempotencyKey: key,
        subject: data.subject,
        body: data.body,
        externalMessageId: null,
        threadId: null,
      };
      rows.set(key, row);
      return row as any;
    },
    async findMessageByIdempotencyKey(key: string) {
      return (rows.get(key) ?? null) as any;
    },
    async updateMessageSent(id: string, d: { externalMessageId: string; threadId: string }) {
      const row = [...rows.values()].find((r) => r.id === id);
      row.externalMessageId = d.externalMessageId;
      row.threadId = d.threadId;
      return row as any;
    },
    threadContext: {
      async resolve() {
        resolves++;
        if (opts?.throwOnResolve) throw new Error("db read failed");
        return ctx;
      },
    },
  };
  return { deps, rows, resolves: () => resolves };
}

// Captures the draft + options each send receives, so tests can assert the
// threaded subject and EmailSendOptions on BOTH send paths.
function makeEmail() {
  let sends = 0;
  const calls: { draft: EmailDraft; options: EmailSendOptions | undefined }[] = [];
  const email: IEmailProvider = {
    async draft() {
      return draft;
    },
    async send(sentDraft: EmailDraft, _creator, _recipient, options?: EmailSendOptions) {
      sends++;
      calls.push({ draft: sentDraft, options });
      return { messageId: `ext-${sends}`, threadId: `thread-${sends}` };
    },
  };
  return { email, sends: () => sends, calls };
}

async function main() {
  console.log("\nidempotentSend.sendOnce\n");

  await test("fresh send reserves, sends once, finalizes", async () => {
    const { deps, rows } = makeDeps();
    const { email, sends } = makeEmail();
    const r = await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(r.alreadySent, false);
    assert.equal(r.messageId, "ext-1");
    assert.equal(sends(), 1);
    // Row finalized with the provider id.
    assert.equal(rows.get("outreach:i1").externalMessageId, "ext-1");
  });

  await test("retry after a completed send does NOT send again", async () => {
    const { deps } = makeDeps();
    const { email, sends } = makeEmail();
    // First attempt sends.
    await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    // Second attempt (BullMQ retry) — same key. Must skip the send.
    const r2 = await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(r2.alreadySent, true);
    assert.equal(r2.messageId, "ext-1"); // prior identifiers surfaced
    assert.equal(sends(), 1, "send() must be called exactly once across both attempts");
  });

  await test("BUG-E3: crash AFTER reserve, BEFORE send → retry RE-SENDS (no dropped email)", async () => {
    const { deps, rows } = makeDeps();
    const { email, sends } = makeEmail();
    // Simulate attempt 1 crashing after reserve but before send by reserving
    // directly (no send/finalize), leaving a reserved-but-unsent row (its
    // externalMessageId is null).
    await deps.createMessage({
      instance: { connect: { id: "i1" } },
      direction: "OUTBOUND",
      subject: draft.subject,
      body: draft.body,
      idempotencyKey: "outreach:i1",
    } as any);
    assert.equal(rows.get("outreach:i1").externalMessageId, null, "precondition: reserved, unsent");
    // Retry: reserve hits P2002. Because the reserved row was never sent, we must
    // RE-ATTEMPT the send now (not drop the contract-forming email) and finalize
    // the existing reserved row.
    const r = await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(r.alreadySent, false, "a reserved-but-unsent row must be re-sent, not skipped");
    assert.equal(r.messageId, "ext-1"); // now has a provider id
    assert.equal(sends(), 1, "the crashed-before-send message is sent exactly once on retry");
    // The EXISTING reserved row was finalized (no duplicate row created).
    assert.equal(rows.size, 1, "no duplicate Message row");
    assert.equal(rows.get("outreach:i1").externalMessageId, "ext-1");
  });

  await test("BUG-E3: after the recovery send, a further retry does NOT send again", async () => {
    const { deps } = makeDeps();
    const { email, sends } = makeEmail();
    // Reserved-but-unsent, then a retry recovers it (sends once)...
    await deps.createMessage({
      instanceId: "i1",
      direction: "OUTBOUND",
      subject: draft.subject,
      body: draft.body,
      idempotencyKey: "outreach:i1",
    } as any);
    await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    // ...a THIRD attempt now sees a completed row → must not send again.
    const r3 = await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(r3.alreadySent, true);
    assert.equal(r3.messageId, "ext-1");
    assert.equal(sends(), 1, "recovery send happens exactly once across all retries");
  });

  await test("distinct keys send independently", async () => {
    const { deps } = makeDeps();
    const { email, sends } = makeEmail();
    await sendOnce(email, "i1", creator, draft, "followup:i1:1", deps);
    await sendOnce(email, "i1", creator, draft, "followup:i1:2", deps);
    assert.equal(sends(), 2, "different rounds are different sends");
  });

  await test("a non-P2002 createMessage error propagates", async () => {
    const { deps } = makeDeps();
    const { email } = makeEmail();
    deps.createMessage = async () => {
      throw new Error("connection reset");
    };
    await assert.rejects(
      sendOnce(email, "i1", creator, draft, "outreach:i1", deps),
      /connection reset/,
    );
  });

  // ── E5: thread context wired into sendOnce ───────────────────────────────

  await test("E5: resolves thread context exactly once per send", async () => {
    const { deps, resolves } = makeDeps();
    const { email } = makeEmail();
    await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(resolves(), 1, "resolve() must be called exactly once");
  });

  await test("E5: first outbound (empty ctx) is unchanged — subject == draft, no reply target", async () => {
    const { deps, rows } = makeDeps(/* empty ctx */);
    const { email, calls } = makeEmail();
    await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    // Reserved row keeps the draft subject.
    assert.equal(rows.get("outreach:i1").subject, "Hi");
    // Wire draft keeps the draft subject; no reply target.
    assert.equal(calls[0]!.draft.subject, "Hi");
    assert.equal(calls[0]!.options?.replyToExternalId, undefined);
  });

  await test("E5: a canonical subject makes both the reserved row AND the wire carry Re:", async () => {
    const { deps, rows } = makeDeps({ canonicalSubject: "Original", replyToExternalId: "ext-prior" });
    const { email, calls } = makeEmail();
    await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    // The reserved row and the sent draft must have the SAME subject (they agree).
    assert.equal(rows.get("outreach:i1").subject, "Re: Original");
    assert.equal(calls[0]!.draft.subject, "Re: Original");
    assert.equal(rows.get("outreach:i1").subject, calls[0]!.draft.subject);
  });

  await test("E5: replyToExternalId from ctx is passed on the normal send path", async () => {
    const { deps } = makeDeps({ replyToExternalId: "ext-prior" });
    const { email, calls } = makeEmail();
    await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(calls[0]!.options?.replyToExternalId, "ext-prior");
  });

  await test("E5: options ALSO passed on the BUG-E3 crash-recovery re-send path", async () => {
    const { deps } = makeDeps({ replyToExternalId: "ext-prior", canonicalSubject: "Original" });
    const { email, calls } = makeEmail();
    // Reserved-but-unsent row (crash between reserve and send).
    await deps.createMessage({
      instanceId: "i1",
      direction: "OUTBOUND",
      subject: "Re: Original",
      body: draft.body,
      idempotencyKey: "outreach:i1",
    } as any);
    // Retry: hits P2002, recovers via the re-send path — which must thread too.
    await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(calls.length, 1, "exactly one recovery send");
    assert.equal(calls[0]!.options?.replyToExternalId, "ext-prior");
    assert.equal(calls[0]!.draft.subject, "Re: Original");
  });

  // ── E7: recovery & degradation ───────────────────────────────────────────

  await test("E7: a resolver throw degrades to a NEW-thread send (delivery not blocked)", async () => {
    // The resolver fails (e.g. DB read error). sendOnce must still deliver the
    // email — as a new thread — rather than propagate and strand a
    // contract-forming send.
    const { deps, rows } = makeDeps({}, { throwOnResolve: true });
    const { email, calls, sends } = makeEmail();
    const r = await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(sends(), 1, "the email is still sent");
    assert.equal(r.alreadySent, false);
    // New thread: the draft's own subject, no reply target.
    assert.equal(calls[0]!.draft.subject, "Hi");
    assert.equal(calls[0]!.options?.replyToExternalId, undefined);
    // The reserved row used the draft subject too (row and wire agree).
    assert.equal(rows.get("outreach:i1").subject, "Hi");
  });

  await test("E7: a resolver throw on the BUG-E3 recovery path still re-sends as a new thread", async () => {
    // Resolver fails AND there is a reserved-but-unsent row (crash between reserve
    // and send). Recovery must not be blocked by the threading failure: re-send as
    // a new thread and finalize the existing row.
    const { deps, rows } = makeDeps({}, { throwOnResolve: true });
    const { email, calls, sends } = makeEmail();
    await deps.createMessage({
      instanceId: "i1",
      direction: "OUTBOUND",
      subject: "Hi",
      body: draft.body,
      idempotencyKey: "outreach:i1",
    } as any);
    const r = await sendOnce(email, "i1", creator, draft, "outreach:i1", deps);
    assert.equal(sends(), 1, "the crashed-before-send email is recovered");
    assert.equal(r.alreadySent, false);
    assert.equal(calls[0]!.options?.replyToExternalId, undefined, "new thread on degrade");
    assert.equal(rows.size, 1, "no duplicate row");
    assert.equal(rows.get("outreach:i1").externalMessageId, "ext-1");
  });

  console.log(`\n✓ idempotentSend: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
