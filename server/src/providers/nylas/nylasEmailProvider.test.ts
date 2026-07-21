/**
 * Unit tests for NylasEmailProvider's threading surface (Email Threading E4, E6,
 * E7). Uses MockNylasClient (and small inline fakes) as injected clients — no real
 * Nylas account or network. Run with:
 *   npx tsx src/providers/nylas/nylasEmailProvider.test.ts
 *
 * Contract under test:
 *   E4 — send() maps the transport-neutral EmailSendOptions.replyToExternalId onto
 *        Nylas's native replyToMessageId when present, and leaves the request
 *        byte-for-byte unchanged (no replyToMessageId key) when it is absent.
 *   E6 — threadUrl(threadId) builds a provider deep-link from the configured
 *        template, or returns undefined when unconfigured / given an empty id.
 *   E7 — a threaded send that errors (stale/deleted reply target) retries ONCE as a
 *        new thread; a non-threaded send error is NOT swallowed; a send response
 *        that omits threadId is resolved via find().
 */

import assert from "node:assert/strict";
import test from "node:test";
import { NylasEmailProvider } from "./nylasEmailProvider.js";
import { MockNylasClient } from "./mockNylasClient.js";
import type { NylasClientLike } from "./client.js";
import type { Creator } from "../../db/schema.js";
import type { EmailDraft } from "../../engine/types.js";

const creator = {
  id: "c1",
  name: "Robin Vega",
  email: "robin@creators.test",
} as unknown as Creator;

const draft: EmailDraft = { subject: "Re: Collaboration", body: "Hello Robin," };

// Build a provider over a fresh MockNylasClient with a fixed grant id. The third
// constructor arg (thread-URL template) is passed explicitly so these tests never
// depend on process.env leaking in.
function makeProvider(threadUrlTemplate?: string) {
  const client = new MockNylasClient();
  const provider = new NylasEmailProvider(client, "grant-test", threadUrlTemplate);
  return { client, provider };
}

// ── E4: replyToMessageId mapping ──────────────────────────────────────────────

test("E4: sends replyToMessageId when replyToExternalId is present", async () => {
  const { client, provider } = makeProvider();

  await provider.send(draft, creator, undefined, {
    replyToExternalId: "nylas-msg-original-42",
  });

  assert.equal(client.sent.length, 1);
  // The neutral external id is mapped onto Nylas's native reply field, verbatim.
  assert.equal(client.sent[0]!.replyToMessageId, "nylas-msg-original-42");
});

test("E4: request carries NO reply field when options are absent (unchanged behaviour)", async () => {
  const { client, provider } = makeProvider();

  // No options at all — the pre-threading call shape.
  await provider.send(draft, creator);

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0]!.replyToMessageId, undefined);
});

test("E4: request carries NO reply field when options is empty (no reply target)", async () => {
  const { client, provider } = makeProvider();

  // The sendOnce first-outbound path passes options === {} (no replyToExternalId).
  await provider.send(draft, creator, undefined, {});

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0]!.replyToMessageId, undefined);
});

test("E4: an empty-string replyToExternalId is treated as absent (never sent)", async () => {
  const { client, provider } = makeProvider();

  // Defense in depth: the resolver never emits "", but if it did, the conditional
  // spread must still omit the field rather than send replyToMessageId: "".
  await provider.send(draft, creator, undefined, { replyToExternalId: "" });

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0]!.replyToMessageId, undefined);
});

test("E4: subject/body/recipient are unaffected by the threading option", async () => {
  const { client, provider } = makeProvider();

  await provider.send(draft, creator, undefined, {
    replyToExternalId: "nylas-msg-original-42",
  });

  // Only the reply field is added; the rest of the send is identical to today.
  assert.equal(client.sent[0]!.to, "robin@creators.test");
  assert.equal(client.sent[0]!.subject, "Re: Collaboration");
  assert.match(client.sent[0]!.body ?? "", /Hello Robin,/);
});

// ── E6: threadUrl deep-link builder ───────────────────────────────────────────

test("E6: threadUrl returns undefined when no template is configured", () => {
  const { provider } = makeProvider(); // no template
  assert.equal(provider.threadUrl("thread-abc"), undefined);
});

test("E6: threadUrl returns undefined for an empty threadId even when configured", () => {
  const { provider } = makeProvider("https://mail.example.test/threads/{threadId}");
  assert.equal(provider.threadUrl(""), undefined);
});

test("E6: threadUrl substitutes the {threadId} placeholder", () => {
  const { provider } = makeProvider("https://mail.example.test/threads/{threadId}");
  assert.equal(
    provider.threadUrl("thread-abc"),
    "https://mail.example.test/threads/thread-abc",
  );
});

test("E6: threadUrl appends when the template has no placeholder", () => {
  const { provider } = makeProvider("https://mail.example.test/threads/");
  assert.equal(
    provider.threadUrl("thread-abc"),
    "https://mail.example.test/threads/thread-abc",
  );
});

test("E6: threadUrl URL-encodes the thread id", () => {
  const { provider } = makeProvider("https://mail.example.test/threads/{threadId}");
  assert.equal(
    provider.threadUrl("a b/c?d"),
    "https://mail.example.test/threads/a%20b%2Fc%3Fd",
  );
});

// ── E6b: rfc822MessageId (Gmail deep-link source) ─────────────────────────────

test("E6b: rfc822MessageId fetches the Message-ID header and strips angle brackets", async () => {
  const { client, provider } = makeProvider();
  // Send so the mock has a known message id; find(...) returns a synthetic
  // "<{id}@mail.gmail.com>" header when include_headers is requested.
  const { messageId } = await provider.send(draft, creator);
  const rfc822 = await provider.rfc822MessageId(messageId);
  assert.equal(rfc822, `${messageId}@mail.gmail.com`); // brackets stripped
});

test("E6b: rfc822MessageId returns undefined for an empty id (no fetch)", async () => {
  const { provider } = makeProvider();
  assert.equal(await provider.rfc822MessageId(""), undefined);
});

test("E6b: rfc822MessageId returns undefined (never throws) when the fetch fails", async () => {
  const client: NylasClientLike = {
    messages: {
      send: async () => ({ data: { id: "x", threadId: "t" } }),
      find: async () => {
        throw new Error("nylas find boom");
      },
    },
  };
  const provider = new NylasEmailProvider(client, "grant-test");
  assert.equal(await provider.rfc822MessageId("some-id"), undefined);
});

// ── E7: recovery & degradation at the provider ────────────────────────────────

// A client that fails the FIRST send whose requestBody carries replyToMessageId
// (simulating a stale/deleted reply target), then succeeds. Records every attempt
// so the test can assert the retry dropped the reply linkage.
function makeFlakyThreadClient(): {
  client: NylasClientLike;
  attempts: Array<{ replyToMessageId: string | undefined }>;
} {
  const attempts: Array<{ replyToMessageId: string | undefined }> = [];
  let sends = 0;
  const client: NylasClientLike = {
    messages: {
      async send(params) {
        sends++;
        const replyToMessageId = params.requestBody.replyToMessageId;
        attempts.push({ replyToMessageId });
        // Fail only the threaded attempt (the reply target "no longer exists").
        if (replyToMessageId) {
          throw new Error("404 message not found");
        }
        return { data: { id: `msg-${sends}`, threadId: `thread-${sends}` } };
      },
      async find(params) {
        return { data: { id: params.messageId, threadId: "thread-found" } };
      },
    },
  };
  return { client, attempts };
}

test("E7: a threaded send that errors retries ONCE as a new thread and succeeds", async () => {
  const { client, attempts } = makeFlakyThreadClient();
  const provider = new NylasEmailProvider(client, "grant-test");

  const result = await provider.send(draft, creator, undefined, {
    replyToExternalId: "stale-msg-id",
  });

  // Two attempts: the threaded one (failed) then the new-thread retry (succeeded).
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.replyToMessageId, "stale-msg-id", "first attempt threaded");
  assert.equal(attempts[1]!.replyToMessageId, undefined, "retry dropped the reply linkage");
  // Delivery succeeded — a messageId + threadId are returned, not an error.
  assert.equal(result.messageId, "msg-2");
  assert.ok(result.threadId);
});

test("E7: a NON-threaded send error is NOT swallowed (propagates, no double-send)", async () => {
  // A brand-new-thread send (no reply id) that fails is a genuine outage — it must
  // surface so retries/alerting see it, and must NOT be retried a second time.
  let sends = 0;
  const client: NylasClientLike = {
    messages: {
      async send() {
        sends++;
        throw new Error("smtp unreachable");
      },
      async find(params) {
        return { data: { id: params.messageId } };
      },
    },
  };
  const provider = new NylasEmailProvider(client, "grant-test");

  await assert.rejects(
    provider.send(draft, creator), // no options → new thread
    /smtp unreachable/,
  );
  assert.equal(sends, 1, "a new-thread failure is attempted exactly once (no hidden retry)");
});

test("E7: send response omitting threadId is resolved via find()", async () => {
  // Nylas frequently omits threadId on a brand-new thread's send response; the
  // provider fetches the message back to read its authoritative threadId.
  const client: NylasClientLike = {
    messages: {
      async send() {
        return { data: { id: "msg-new" /* no threadId */ } };
      },
      async find(params) {
        return { data: { id: params.messageId, threadId: "resolved-thread" } };
      },
    },
  };
  const provider = new NylasEmailProvider(client, "grant-test");

  const result = await provider.send(draft, creator);
  assert.equal(result.messageId, "msg-new");
  assert.equal(result.threadId, "resolved-thread", "threadId came from find()");
});
