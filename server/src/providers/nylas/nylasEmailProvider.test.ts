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
import { MockEmailProvider, isThreadLabeler } from "../../engine/providers.js";
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
// depend on process.env leaking in. The fourth (labelsEnabled) is likewise passed
// explicitly so the Gmail-label tests don't depend on GMAIL_LABELS_ENABLED leaking.
function makeProvider(threadUrlTemplate?: string, labelsEnabled = false) {
  const client = new MockNylasClient();
  const provider = new NylasEmailProvider(
    client,
    "grant-test",
    threadUrlTemplate,
    labelsEnabled,
  );
  return { client, provider };
}

// ── Gmail Campaign Labels — isThreadLabeler guard (§6.1) ──────────────────────

test("labels: isThreadLabeler is TRUE for NylasEmailProvider", () => {
  const { provider } = makeProvider();
  assert.equal(isThreadLabeler(provider), true);
});

test("labels: isThreadLabeler is FALSE for MockEmailProvider (feature no-ops under mock)", () => {
  assert.equal(isThreadLabeler(new MockEmailProvider()), false);
});

// ── Gmail Campaign Labels — applyThreadLabel (§6.5, §6.6) ─────────────────────

test("labels: flag OFF ⇒ applyThreadLabel is a pure no-op (no list/create/update)", async () => {
  const { client, provider } = makeProvider(undefined, /* labelsEnabled */ false);
  await provider.applyThreadLabel("nylas-thread-x", "Pluvus/Summer Skincare");
  assert.equal(client.listCalls, 0);
  assert.equal(client.createCalls, 0);
  assert.equal(client.threadUpdateCalls, 0);
});

test("labels: flag ON ⇒ creates the label then applies it to the thread (unioned)", async () => {
  const { client, provider } = makeProvider(undefined, true);
  // Send so the thread exists with its seeded INBOX folder.
  const { threadId } = await provider.send(draft, creator);
  await provider.applyThreadLabel(threadId, "Pluvus/Summer Skincare");

  // One list (miss) + one create + one thread update.
  assert.equal(client.listCalls, 1, "listed folders once on the cache miss");
  assert.equal(client.createCalls, 1, "created the missing label once");
  assert.equal(client.threadUpdateCalls, 1, "applied the label to the thread once");
  // The label folder exists...
  const created = client.folderStore.find((f) => f.name === "Pluvus/Summer Skincare");
  assert.ok(created, "the Pluvus/<name> folder was created");
  // ...and the thread now carries INBOX (preserved) + the new label id (unioned).
  const threadSet = client.threadFolders.get(threadId)!;
  assert.ok(threadSet.includes("INBOX"), "existing INBOX folder is preserved (not clobbered)");
  assert.ok(threadSet.includes(created!.id), "the new label id was added");
});

test("labels: filters Gmail read-only system labels from the thread write-back", async () => {
  // A thread carrying read-only system labels (SENT/CATEGORY_*) alongside
  // user-modifiable ones. Gmail's threads.update rejects re-asserting the
  // read-only ones ("unsupported Google label: SENT"), so applyThreadLabel must
  // send back only [modifiable labels + our label], never the read-only ones.
  let sentFolders: string[] | undefined;
  const client: NylasClientLike = {
    messages: {
      send: async () => ({ data: { id: "m1", threadId: "t1" } }),
      find: async (p) => ({ data: { id: p.messageId, threadId: "t1" } }),
    },
    folders: {
      list: async () => ({ data: [{ id: "lbl-1", name: "Pluvus/X" }] }),
      create: async () => ({ data: { id: "lbl-1", name: "Pluvus/X" } }),
    },
    threads: {
      find: async (p) => ({
        data: {
          id: p.threadId,
          folders: ["INBOX", "SENT", "IMPORTANT", "CATEGORY_PERSONAL", "UNREAD"],
        },
      }),
      update: async (p) => {
        sentFolders = p.requestBody.folders;
        return { data: { id: p.threadId, ...(p.requestBody.folders ? { folders: p.requestBody.folders } : {}) } };
      },
    },
  };
  const provider = new NylasEmailProvider(client, "grant-test", undefined, true);
  await provider.applyThreadLabel("t1", "Pluvus/X");

  assert.ok(sentFolders, "threads.update was called");
  // Read-only system labels are excluded...
  assert.ok(!sentFolders!.includes("SENT"), "SENT (read-only) is filtered out");
  assert.ok(!sentFolders!.includes("CATEGORY_PERSONAL"), "CATEGORY_* (read-only) is filtered out");
  // ...modifiable labels are preserved, and our label added.
  assert.ok(sentFolders!.includes("INBOX"), "INBOX (modifiable) is preserved");
  assert.ok(sentFolders!.includes("IMPORTANT"), "IMPORTANT (modifiable) is preserved");
  assert.ok(sentFolders!.includes("UNREAD"), "UNREAD (modifiable) is preserved");
  assert.ok(sentFolders!.includes("lbl-1"), "the new label id is added");
});

test("labels: reuses an EXISTING label (no create) and finds it by exact name", async () => {
  const { client, provider } = makeProvider(undefined, true);
  // Pre-seed the label as if a prior run created it.
  const seeded = await client.folders.create({
    identifier: "grant-test",
    requestBody: { name: "Pluvus/Existing" },
  });
  client.createCalls = 0; // reset after seeding

  const { threadId } = await provider.send(draft, creator);
  await provider.applyThreadLabel(threadId, "Pluvus/Existing");

  assert.equal(client.createCalls, 0, "an existing label is NOT re-created");
  const threadSet = client.threadFolders.get(threadId)!;
  assert.ok(threadSet.includes(seeded.data.id), "the existing label id was applied");
});

test("labels: second apply for the same label hits the CACHE (only one folders.list)", async () => {
  const { client, provider } = makeProvider(undefined, true);
  const { threadId } = await provider.send(draft, creator);

  await provider.applyThreadLabel(threadId, "Pluvus/Cached");
  await provider.applyThreadLabel(threadId, "Pluvus/Cached");

  assert.equal(client.listCalls, 1, "the second apply reused the cached label id (no re-list)");
  assert.equal(client.createCalls, 1, "the label is created exactly once");
});

test("labels: re-applying an already-present label is a no-op (no second thread update)", async () => {
  const { client, provider } = makeProvider(undefined, true);
  const { threadId } = await provider.send(draft, creator);

  await provider.applyThreadLabel(threadId, "Pluvus/Once");
  const afterFirst = client.threadUpdateCalls;
  // Second apply: label already on the thread → must skip the update entirely.
  await provider.applyThreadLabel(threadId, "Pluvus/Once");

  assert.equal(afterFirst, 1);
  assert.equal(client.threadUpdateCalls, 1, "already-present label → no redundant thread update");
});

test("labels: concurrent applies for a brand-new label collapse to a SINGLE create (single-flight)", async () => {
  const { client, provider } = makeProvider(undefined, true);
  const { threadId } = await provider.send(draft, creator);

  // Two overlapping applies for the SAME brand-new label.
  await Promise.all([
    provider.applyThreadLabel(threadId, "Pluvus/Race"),
    provider.applyThreadLabel(threadId, "Pluvus/Race"),
  ]);

  assert.equal(client.createCalls, 1, "single-flight: the create fires exactly once");
  const matches = client.folderStore.filter((f) => f.name === "Pluvus/Race");
  assert.equal(matches.length, 1, "no duplicate label folder created");
});

test("labels: create-conflict is recovered by re-reading the list (never throws)", async () => {
  // A client whose create() ALWAYS conflicts, but whose second list() surfaces the
  // now-existing label (as if another process created it). applyThreadLabel must
  // recover and apply it — and never throw.
  let listCount = 0;
  const conflictLabel = "Pluvus/Conflict";
  const conflictId = "folder-from-other-process";
  const client: NylasClientLike = {
    messages: {
      send: async () => ({ data: { id: "m1", threadId: "t1" } }),
      find: async (p) => ({ data: { id: p.messageId, threadId: "t1" } }),
    },
    folders: {
      list: async () => {
        listCount++;
        // First list (initial miss): empty. Second list (post-conflict re-read):
        // the label now exists.
        return listCount === 1
          ? { data: [] }
          : { data: [{ id: conflictId, name: conflictLabel }] };
      },
      create: async () => {
        throw new Error("409 folder already exists");
      },
    },
    threads: {
      find: async (p) => ({ data: { id: p.threadId, folders: ["INBOX"] } }),
      update: async (p) => ({
        data: {
          id: p.threadId,
          ...(p.requestBody.folders ? { folders: p.requestBody.folders } : {}),
        },
      }),
    },
  };
  const provider = new NylasEmailProvider(client, "grant-test", undefined, true);

  // Must resolve (not reject) and recover the conflicting label.
  await provider.applyThreadLabel("t1", conflictLabel);
  assert.equal(listCount, 2, "re-read the list after the create conflict");
});

test("labels: a folders.list failure never throws — the send is unaffected", async () => {
  const client: NylasClientLike = {
    messages: {
      send: async () => ({ data: { id: "m1", threadId: "t1" } }),
      find: async (p) => ({ data: { id: p.messageId, threadId: "t1" } }),
    },
    folders: {
      list: async () => {
        throw new Error("nylas list boom");
      },
      create: async () => ({ data: { id: "x", name: "x" } }),
    },
    threads: {
      find: async (p) => ({ data: { id: p.threadId, folders: [] } }),
      update: async (p) => ({
        data: {
          id: p.threadId,
          ...(p.requestBody.folders ? { folders: p.requestBody.folders } : {}),
        },
      }),
    },
  };
  const provider = new NylasEmailProvider(client, "grant-test", undefined, true);
  // The whole point: this resolves, never rejects.
  await provider.applyThreadLabel("t1", "Pluvus/X");
});

test("labels: a threads.update failure never throws (best-effort apply)", async () => {
  const client: NylasClientLike = {
    messages: {
      send: async () => ({ data: { id: "m1", threadId: "t1" } }),
      find: async (p) => ({ data: { id: p.messageId, threadId: "t1" } }),
    },
    folders: {
      list: async () => ({ data: [{ id: "lbl-1", name: "Pluvus/X" }] }),
      create: async () => ({ data: { id: "lbl-1", name: "Pluvus/X" } }),
    },
    threads: {
      find: async (p) => ({ data: { id: p.threadId, folders: ["INBOX"] } }),
      update: async () => {
        throw new Error("nylas update boom");
      },
    },
  };
  const provider = new NylasEmailProvider(client, "grant-test", undefined, true);
  await provider.applyThreadLabel("t1", "Pluvus/X"); // resolves, never rejects
});

test("labels: missing SDK folders/threads surface ⇒ no-op (no crash on a read-only fake)", async () => {
  // A client WITHOUT the folders/threads surface (e.g. an older fake) must no-op.
  const client: NylasClientLike = {
    messages: {
      send: async () => ({ data: { id: "m1", threadId: "t1" } }),
      find: async (p) => ({ data: { id: p.messageId, threadId: "t1" } }),
    },
    // no folders, no threads
  };
  const provider = new NylasEmailProvider(client, "grant-test", undefined, true);
  await provider.applyThreadLabel("t1", "Pluvus/X"); // resolves, never rejects
});

test("labels: empty threadId or label ⇒ no-op", async () => {
  const { client, provider } = makeProvider(undefined, true);
  await provider.applyThreadLabel("", "Pluvus/X");
  await provider.applyThreadLabel("t1", "");
  assert.equal(client.listCalls, 0);
  assert.equal(client.threadUpdateCalls, 0);
});

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
