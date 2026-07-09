import NylasImport from "nylas";

// Under NodeNext module resolution the `nylas` default export's construct
// signature is not always surfaced through the interop binding. Re-type it as a
// plain constructor of the surface we use so `new` is well-typed.
const Nylas = NylasImport as unknown as new (config: {
  apiKey: string;
  apiUri?: string;
}) => NylasClientLike;

// ---------------------------------------------------------------------------
// Nylas client singleton
// ---------------------------------------------------------------------------
// Lazily constructs a single Nylas SDK client from environment config and
// caches it for the process. Only the surface we actually use is exposed via
// NylasClientLike so the real SDK and the test mock (mockNylasClient.ts) are
// interchangeable behind one type.
//
// Required env when EMAIL_PROVIDER=nylas:
//   NYLAS_API_KEY   — application API key (Bearer auth)
//   NYLAS_GRANT_ID  — the connected account grant to send as
// Optional:
//   NYLAS_API_URI   — API base URI override (defaults to the SDK's US endpoint)

/**
 * The minimal slice of the Nylas SDK this integration depends on.
 * Mirrors `nylas.messages.send(...)`'s shape so a fake can stand in for tests.
 */
export interface NylasClientLike {
  messages: {
    send(params: {
      identifier: string;
      requestBody: {
        to: Array<{ email: string; name?: string }>;
        subject?: string;
        body?: string;
        // Optional Reply-To. Brand-decision emails (CRITICAL-2) set a token-scoped
        // reply-to so a brand's reply is attributable to exactly one decision.
        replyTo?: Array<{ email: string; name?: string }>;
        // Optional file attachments (Phase 16 — Content Brief). Nylas expects
        // each as base64-encoded `content` plus filename/content_type. Omitted
        // for every send except the Content Brief campaign-brief email.
        attachments?: Array<{
          filename: string;
          contentType: string;
          content: string;
        }>;
      };
    }): Promise<{ data: { id: string; threadId?: string } }>;
    /**
     * Fetch a single message by id. Used to resolve the real threadId when the
     * send response omits it (common for a brand-new thread) — the persisted
     * message resource always carries its threadId.
     */
    find(params: {
      identifier: string;
      messageId: string;
    }): Promise<{ data: { id: string; threadId?: string } }>;
  };
}

let _client: NylasClientLike | undefined;

/** The grant id this process sends mail as. Read once, validated on first use. */
export function nylasGrantId(): string {
  const grantId = process.env["NYLAS_GRANT_ID"];
  if (!grantId) {
    throw new Error(
      "NYLAS_GRANT_ID is not set. Required when EMAIL_PROVIDER=nylas.",
    );
  }
  return grantId;
}

/**
 * Returns the cached Nylas client, constructing it on first call.
 * Throws a clear error if NYLAS_API_KEY is missing so misconfiguration fails
 * loudly at send time rather than producing a cryptic SDK error.
 */
export function getNylasClient(): NylasClientLike {
  if (_client) return _client;

  const apiKey = process.env["NYLAS_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "NYLAS_API_KEY is not set. Required when EMAIL_PROVIDER=nylas.",
    );
  }

  const apiUri = process.env["NYLAS_API_URI"];
  _client = new Nylas({
    apiKey,
    ...(apiUri ? { apiUri } : {}),
  });

  return _client;
}

/**
 * Inject a client (used by tests to supply mockNylasClient). Passing undefined
 * clears the cache so the next getNylasClient() rebuilds from env.
 */
export function setNylasClient(client: NylasClientLike | undefined): void {
  _client = client;
}
