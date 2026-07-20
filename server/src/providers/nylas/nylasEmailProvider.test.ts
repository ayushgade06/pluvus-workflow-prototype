/**
 * Unit tests for NylasEmailProvider's threading surface (Email Threading E4 + E6).
 * Uses MockNylasClient as an injected fake — no real Nylas account or network.
 * Run with:  npx tsx src/providers/nylas/nylasEmailProvider.test.ts
 *
 * Contract under test:
 *   E4 — send() maps the transport-neutral EmailSendOptions.replyToExternalId onto
 *        Nylas's native replyToMessageId when present, and leaves the request
 *        byte-for-byte unchanged (no replyToMessageId key) when it is absent.
 *   E6 — threadUrl(threadId) builds a provider deep-link from the configured
 *        template, or returns undefined when unconfigured / given an empty id.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { NylasEmailProvider } from "./nylasEmailProvider.js";
import { MockNylasClient } from "./mockNylasClient.js";
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
