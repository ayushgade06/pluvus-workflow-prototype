/**
 * Unit tests for the shared idempotent outbound send (FIX-11 generalized).
 * In-memory fakes for the DB seam + email provider — no live database.
 * Run with:  npx tsx src/engine/executors/idempotentSend.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "../../db/schema.js";
import { sendOnce, type SendOnceDeps } from "./idempotentSend.js";
import type { IEmailProvider } from "../providers.js";
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
function makeDeps() {
  const rows = new Map<string, any>();
  let seq = 0;
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
  };
  return { deps, rows };
}

function makeEmail() {
  let sends = 0;
  const email: IEmailProvider = {
    async draft() {
      return draft;
    },
    async send() {
      sends++;
      return { messageId: `ext-${sends}`, threadId: `thread-${sends}` };
    },
  };
  return { email, sends: () => sends };
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

  console.log(`\n✓ idempotentSend: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
