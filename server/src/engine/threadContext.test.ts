/**
 * Unit tests for the thread-context resolver + subject helper (Email Threading
 * E3). Pure/in-memory — an injected message list stands in for the DB seam; no
 * live database, no provider. Run with:
 *   npx tsx src/engine/threadContext.test.ts
 * (also picked up by `npm test`, which globs the src test files under tsx --test).
 */

import assert from "node:assert/strict";
import type { Message } from "../db/schema.js";
import {
  DefaultThreadContextResolver,
  buildReplySubject,
  type ThreadContextDeps,
} from "./threadContext.js";

let n = 0;
function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    n++;
    console.log(`  ✓ ${name}`);
  });
}

// Minimal Message factory — only the fields the resolver reads matter; the rest
// are the schema's nullable defaults. `atMs` seeds createdAt so callers can order
// rows explicitly (the real query returns them createdAt asc).
function msg(
  overrides: Partial<Message> & { direction: Message["direction"] },
  atMs: number,
): Message {
  return {
    id: `m${atMs}`,
    instanceId: "i1",
    subject: null,
    body: "",
    threadId: null,
    senderEmail: null,
    externalMessageId: null,
    idempotencyKey: null,
    replyIntent: null,
    classifyConfidence: null,
    sentAt: null,
    receivedAt: null,
    processedAt: null,
    createdAt: new Date(atMs),
    ...overrides,
  } as Message;
}

// Build a resolver over a fixed list, counting reads so we can assert "one read".
function makeResolver(rows: Message[]) {
  let calls = 0;
  const deps: ThreadContextDeps = {
    async listMessagesByInstance(_instanceId: string) {
      calls++;
      return rows;
    },
  };
  return { resolver: new DefaultThreadContextResolver(deps), calls: () => calls };
}

async function main() {
  console.log("\nthreadContext.DefaultThreadContextResolver\n");

  await test("empty history → all fields undefined (new thread)", async () => {
    const { resolver } = makeResolver([]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.replyToExternalId, undefined);
    assert.equal(ctx.canonicalSubject, undefined);
    assert.equal(ctx.threadId, undefined);
  });

  await test("performs exactly one DB read", async () => {
    const { resolver, calls } = makeResolver([
      msg({ direction: "OUTBOUND", subject: "Hi", externalMessageId: "o1", threadId: "t1" }, 10),
    ]);
    await resolver.resolve("i1");
    assert.equal(calls(), 1, "listMessagesByInstance must be called exactly once");
  });

  await test("replyToExternalId = latest row with an external id, across mixed directions", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "OUTBOUND", subject: "Hi", externalMessageId: "o1", threadId: "t1" }, 10),
      msg({ direction: "INBOUND", externalMessageId: "i-reply", threadId: "t1" }, 20),
      msg({ direction: "OUTBOUND", subject: "Re: Hi", externalMessageId: "o2", threadId: "t1" }, 30),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.replyToExternalId, "o2", "the chronologically last external id wins");
  });

  await test("latest either direction — an inbound reply is a valid reply target", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "OUTBOUND", subject: "Hi", externalMessageId: "o1", threadId: "t1" }, 10),
      msg({ direction: "INBOUND", externalMessageId: "i-reply", threadId: "t1" }, 20),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.replyToExternalId, "i-reply");
  });

  await test("skips a reserved-but-unsent row (null externalMessageId)", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "OUTBOUND", subject: "Hi", externalMessageId: "o1", threadId: "t1" }, 10),
      // BUG-E3 window: reserved but never sent → no external id. Must be skipped.
      msg({ direction: "OUTBOUND", subject: "Re: Hi", externalMessageId: null, threadId: null }, 20),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.replyToExternalId, "o1", "fall back to the most recent SENT row");
  });

  await test("never emits an empty-string replyToExternalId", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "OUTBOUND", subject: "Hi", externalMessageId: "", threadId: null }, 10),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.replyToExternalId, undefined, "empty string is treated as absent");
  });

  await test("canonicalSubject = FIRST outbound subject", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "INBOUND", externalMessageId: "i0", threadId: "t1" }, 5),
      msg({ direction: "OUTBOUND", subject: "Original subject", externalMessageId: "o1", threadId: "t1" }, 10),
      msg({ direction: "OUTBOUND", subject: "Re: Original subject", externalMessageId: "o2", threadId: "t1" }, 30),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.canonicalSubject, "Original subject");
  });

  await test("threadId comes from the reply-target row", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "OUTBOUND", subject: "Hi", externalMessageId: "o1", threadId: "thread-xyz" }, 10),
      msg({ direction: "INBOUND", externalMessageId: "i1", threadId: "thread-xyz" }, 20),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.threadId, "thread-xyz");
  });

  await test("history with no outbound and no external ids → all undefined", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "INBOUND", externalMessageId: null, threadId: null }, 10),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.replyToExternalId, undefined);
    assert.equal(ctx.canonicalSubject, undefined);
    assert.equal(ctx.threadId, undefined);
  });

  // E7 (missing threadId on the reply-target row): the send must still carry
  // replyToExternalId — the provider derives the thread from it, and resolveThreadId
  // finalises our row. threadId (a READ concern, only for E6's link) is simply
  // omitted here, never fabricated.
  await test("E7: reply target with a null threadId still yields replyToExternalId", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "OUTBOUND", subject: "Hi", externalMessageId: "o1", threadId: null }, 10),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.replyToExternalId, "o1", "reply target is usable without a threadId");
    assert.equal(ctx.threadId, undefined, "threadId omitted, not invented");
    assert.equal(ctx.canonicalSubject, "Hi");
  });

  // E7 (all reply targets are reserved-but-unsent): every candidate lacks an
  // external id → no reply target at all → open a new thread, but the canonical
  // subject (first outbound) is still available so the NEXT send can thread onto it.
  await test("E7: only reserved-but-unsent outbound rows → new thread, canonical still set", async () => {
    const { resolver } = makeResolver([
      msg({ direction: "OUTBOUND", subject: "Original", externalMessageId: null, threadId: null }, 10),
      msg({ direction: "OUTBOUND", subject: "Original", externalMessageId: null, threadId: null }, 20),
    ]);
    const ctx = await resolver.resolve("i1");
    assert.equal(ctx.replyToExternalId, undefined, "no sent row → no reply target");
    assert.equal(ctx.threadId, undefined);
    assert.equal(ctx.canonicalSubject, "Original", "first outbound subject is still the canonical");
  });

  console.log("\nthreadContext.buildReplySubject\n");

  await test("no canonical → returns the draft's own subject unchanged", () => {
    assert.equal(buildReplySubject(undefined, "Fresh subject"), "Fresh subject");
  });

  await test("canonical → Re: <canonical>", () => {
    assert.equal(buildReplySubject("Collaboration opportunity", "ignored draft subject"), "Re: Collaboration opportunity");
  });

  await test("idempotent — an already-Re: canonical does not become Re: Re:", () => {
    assert.equal(buildReplySubject("Re: Collaboration opportunity", "x"), "Re: Collaboration opportunity");
  });

  await test("case-insensitive strip of a leading re:", () => {
    assert.equal(buildReplySubject("RE: Collaboration", "x"), "Re: Collaboration");
    assert.equal(buildReplySubject("re: Collaboration", "x"), "Re: Collaboration");
    assert.equal(buildReplySubject("rE:Collaboration", "x"), "Re: Collaboration");
  });

  await test("only ONE leading Re: is stripped (an inner Re: is preserved)", () => {
    assert.equal(buildReplySubject("Re: Re: Deep thread", "x"), "Re: Re: Deep thread");
  });

  await test("empty canonical subject is still a canonical (→ Re: )", () => {
    // Distinct from `undefined` (no prior outbound). An empty-but-present subject
    // is unusual but must not fall through to the draft subject.
    assert.equal(buildReplySubject("", "draft subject"), "Re: ");
  });

  console.log(`\n✓ threadContext: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
