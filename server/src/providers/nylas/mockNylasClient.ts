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
}

export class MockNylasClient implements NylasClientLike {
  readonly sent: SentMessageRecord[] = [];
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
      });

      return { data: { id, threadId } };
    },

    // Resolve a sent message back to its threadId, mirroring nylas.messages.find.
    // Used by NylasEmailProvider.resolveThreadId when a send response omits the
    // threadId. Returns the recorded threadId for a known message id.
    find: async (params: {
      identifier: string;
      messageId: string;
    }): Promise<{ data: { id: string; threadId?: string } }> => {
      const record = this.sent.find((m) => m.id === params.messageId);
      return { data: { id: params.messageId, ...(record ? { threadId: record.threadId } : {}) } };
    },
  };
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
 */
export function buildSignedWebhook(
  inbound: SimulatedInbound,
  secret: string,
): { rawBody: string; signature: string } {
  const payload = {
    type: "message.created",
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
