import type { NylasClientLike } from "./client.js";
import { computeSignature } from "./verifySignature.js";

// ---------------------------------------------------------------------------
// MockNylasClient — a fake Nylas SDK for tests and local dev without a real
// email account.
// ---------------------------------------------------------------------------
// - messages.send(): returns deterministic { id, threadId } and records every
//   sent message so tests can assert on outbound behavior. The thread id is
//   keyed off the recipient so a reply to the same creator correlates back.
// - buildSignedWebhook(): produces a realistic message.created webhook payload
//   for an inbound reply AND the matching X-Nylas-Signature, so a harness can
//   POST a correctly-signed delivery to /webhooks/nylas with no real Nylas.

export interface SentMessageRecord {
  to: string;
  subject: string | undefined;
  body: string | undefined;
  id: string;
  threadId: string;
  // Email Threading — E4: the reply-linkage field, when the send threaded onto a
  // prior message. undefined for a new-thread send (the field was omitted).
  replyToMessageId: string | undefined;
  // Gmail Campaign Labels: the folder/label ids this message currently appears
  // in. Seeded to a couple of "system" folders so a test can prove
  // applyThreadLabel UNIONs (adds) the label rather than overwriting the set.
  folders: string[];
}

/** A fake Gmail label/folder as Nylas models it (id + name). */
export interface FolderRecord {
  id: string;
  name: string;
}

export class MockNylasClient implements NylasClientLike {
  readonly sent: SentMessageRecord[] = [];
  // Gmail Campaign Labels: the fake label/folder store + call counters so tests
  // can assert find-or-create hits the cache (one list) and creates race-collapse
  // to a single create.
  readonly folderStore: FolderRecord[] = [];
  listCalls = 0;
  createCalls = 0;
  // Gmail Campaign Labels — per-thread folder/label id sets, seeded lazily to the
  // "INBOX" system folder on first touch so a label apply must UNION (add), not
  // overwrite. Tests read this back to prove the system folders were preserved.
  readonly threadFolders = new Map<string, string[]>();
  threadUpdateCalls = 0;
  private counter = 0;

  // Deterministic id generator (no Date.now()/random so tests are stable).
  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  messages = {
    send: async (params: {
      identifier: string;
      requestBody: {
        to: Array<{ email: string; name?: string }>;
        subject?: string;
        body?: string;
        // E4: recorded so tests can assert threading behavior (present on a
        // threaded reply, absent on a new-thread send).
        replyToMessageId?: string;
      };
    }): Promise<{ data: { id: string; threadId?: string } }> => {
      const recipient = params.requestBody.to[0]?.email ?? "unknown@example.com";
      const id = this.nextId("nylas-msg");
      // Stable thread per recipient so a simulated reply lands on the same thread.
      const threadId = `nylas-thread-${recipient}`;

      this.sent.push({
        to: recipient,
        subject: params.requestBody.subject,
        body: params.requestBody.body,
        id,
        threadId,
        replyToMessageId: params.requestBody.replyToMessageId,
        // Seed the message with the "sent" system folder so a label apply must
        // UNION (add) rather than overwrite — mirroring a real Gmail message.
        folders: ["SENT"],
      });

      return { data: { id, threadId } };
    },

    // Resolve a sent message back to its threadId, mirroring nylas.messages.find.
    // Used by NylasEmailProvider.resolveThreadId when a send response omits the
    // threadId. Returns the recorded threadId for a known message id. When
    // `fields=include_headers` is requested it also returns a synthetic RFC822
    // Message-ID header, mirroring the real API — used to test rfc822MessageId().
    find: async (params: {
      identifier: string;
      messageId: string;
      queryParams?: { fields?: string };
    }): Promise<{
      data: {
        id: string;
        threadId?: string;
        headers?: Array<{ name: string; value: string }>;
        folders?: string[];
      };
    }> => {
      const record = this.sent.find((m) => m.id === params.messageId);
      const wantHeaders = params.queryParams?.fields === "include_headers";
      return {
        data: {
          id: params.messageId,
          ...(record ? { threadId: record.threadId } : {}),
          // Gmail Campaign Labels: expose the message's current folder set so
          // applyThreadLabel reads it and unions the new label id.
          ...(record ? { folders: record.folders } : {}),
          ...(wantHeaders
            ? { headers: [{ name: "Message-ID", value: `<${params.messageId}@mail.gmail.com>` }] }
            : {}),
        },
      };
    },

    // Gmail Campaign Labels: set the message's folder id set (Nylas overwrite
    // semantics). applyThreadLabel passes the UNION of existing + label, so this
    // records the full resulting set — a test can read it back to prove the
    // system folders were preserved (not clobbered).
    update: async (params: {
      identifier: string;
      messageId: string;
      requestBody: { folders?: string[] };
    }): Promise<{ data: { id: string; folders?: string[] } }> => {
      const record = this.sent.find((m) => m.id === params.messageId);
      if (record && params.requestBody.folders) {
        record.folders = [...params.requestBody.folders];
      }
      return {
        data: {
          id: params.messageId,
          ...(record ? { folders: record.folders } : {}),
        },
      };
    },
  };

  // Gmail Campaign Labels — the fake Folders (== Gmail labels) API.
  folders = {
    list: async (_params: {
      identifier: string;
    }): Promise<{ data: FolderRecord[] }> => {
      this.listCalls += 1;
      // Return a shallow copy so callers can't mutate the store by reference.
      return { data: this.folderStore.map((f) => ({ ...f })) };
    },
    create: async (params: {
      identifier: string;
      requestBody: { name: string };
    }): Promise<{ data: FolderRecord }> => {
      this.createCalls += 1;
      const folder: FolderRecord = {
        id: this.nextId("nylas-folder"),
        name: params.requestBody.name,
      };
      this.folderStore.push(folder);
      return { data: folder };
    },
  };

  // Gmail Campaign Labels — the fake Threads API (chosen apply mechanism, ADR §3).
  threads = {
    find: async (params: {
      identifier: string;
      threadId: string;
    }): Promise<{ data: { id: string; folders?: string[] } }> => {
      const folders = this.threadFoldersFor(params.threadId);
      return { data: { id: params.threadId, folders: [...folders] } };
    },
    update: async (params: {
      identifier: string;
      threadId: string;
      requestBody: { folders?: string[] };
    }): Promise<{ data: { id: string; folders?: string[] } }> => {
      this.threadUpdateCalls += 1;
      if (params.requestBody.folders) {
        this.threadFolders.set(params.threadId, [...params.requestBody.folders]);
      }
      return {
        data: { id: params.threadId, folders: this.threadFoldersFor(params.threadId) },
      };
    },
  };

  // Lazily seed a thread's folder set with the "INBOX" system folder so a label
  // apply must union (not clobber) it. Returns the live array reference.
  private threadFoldersFor(threadId: string): string[] {
    let folders = this.threadFolders.get(threadId);
    if (!folders) {
      folders = ["INBOX"];
      this.threadFolders.set(threadId, folders);
    }
    return folders;
  }
}

// ---------------------------------------------------------------------------
// Webhook payload + signature builder
// ---------------------------------------------------------------------------

export interface SimulatedInbound {
  messageId: string;
  threadId: string;
  subject: string;
  body: string;
  fromEmail: string;
}

/**
 * Build a Nylas-shaped message.created webhook body (snake_case, as the real
 * webhook sends) and the matching hex HMAC-SHA256 signature for a given secret.
 * Returns the exact raw string to POST plus the X-Nylas-Signature value.
 *
 * `timeSec` (unix seconds) stamps the top-level `time` field that Nylas v3 sends
 * on every delivery — the webhook's replay-freshness guard (BUG-SEC4) reads it.
 * When omitted, no `time` is emitted (the freshness check fails open, matching a
 * legacy payload shape).
 */
export function buildSignedWebhook(
  inbound: SimulatedInbound,
  secret: string,
  timeSec?: number,
): { rawBody: string; signature: string } {
  const payload: Record<string, unknown> = {
    type: "message.created",
    ...(timeSec !== undefined ? { time: timeSec } : {}),
    data: {
      object: {
        id: inbound.messageId,
        grant_id: "mock-grant",
        thread_id: inbound.threadId,
        subject: inbound.subject,
        body: inbound.body,
        from: [{ email: inbound.fromEmail, name: inbound.fromEmail }],
        to: [{ email: "partnerships@pluvus.com", name: "Pluvus" }],
      },
    },
  };

  const rawBody = JSON.stringify(payload);
  const signature = computeSignature(rawBody, secret);
  return { rawBody, signature };
}
