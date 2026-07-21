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
        // Optional reply linkage (Email Threading — E4). The Nylas message id of
        // the message this send replies to; on the wire it serializes to
        // `reply_to_message_id` (E1/V1). When set, Nylas attaches the send to that
        // message's thread and auto-generates the RFC In-Reply-To/References
        // headers (E1/V4), so we never build those by hand. Omitted for a new
        // thread — every send except a threaded reply leaves this unset.
        replyToMessageId?: string;
        // Optional CC (PLU-70). Only the operator-handoff message sets this, to
        // put the campaign's escalation contact into the creator thread.
        cc?: Array<{ email: string; name?: string }>;
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
     *
     * `queryParams.fields: "include_headers"` additionally returns the RFC822
     * headers (incl. the `Message-ID`), which the escalation Gmail deep-link needs
     * — Gmail's cold-load-safe URL keys off the rfc822 Message-ID, not the hex
     * thread id. Optional so existing callers/fakes that only read threadId are
     * unaffected.
     */
    find(params: {
      identifier: string;
      messageId: string;
      queryParams?: { fields?: string };
    }): Promise<{
      data: {
        id: string;
        threadId?: string;
        headers?: Array<{ name: string; value: string }>;
        // The folder/label ids this message currently appears in (Gmail Campaign
        // Labels — read-then-union apply, ADR §3). We read this so applyThreadLabel
        // can ADD our label to the message's existing folders rather than
        // overwriting them (Nylas's messages.update.folders is set-semantics).
        // Optional so existing callers/fakes that only read threadId are unaffected.
        folders?: string[];
      };
    }>;
    /**
     * Update a message (Gmail Campaign Labels — §6.6). We use ONLY the `folders`
     * field to set the label/folder id set the message appears in. Because Gmail
     * models labels at the thread level, labeling the just-sent message surfaces
     * the label on the whole conversation (ADR §3). NOTE: `folders` OVERWRITES the
     * message's folder set, so callers pass the UNION of existing folders + the
     * new label id (never just the label alone). Optional on the interface so
     * existing providers/fakes without label support are unaffected.
     */
    update?(params: {
      identifier: string;
      messageId: string;
      requestBody: { folders?: string[] };
    }): Promise<{ data: { id: string; folders?: string[] } }>;
  };

  /**
   * Nylas Folders API (v3). For a Gmail grant, a "folder" IS a Gmail label
   * (Nylas v3 consolidates Gmail labels + Microsoft folders under Folders — ADR
   * §1). We list to find `Pluvus/<name>` by exact name and create it when absent.
   * Optional on the interface so a fake without label support (or a non-labeling
   * test) need not implement it.
   */
  folders?: {
    list(params: {
      identifier: string;
    }): Promise<{ data: Array<{ id: string; name: string }> }>;
    create(params: {
      identifier: string;
      requestBody: { name: string };
    }): Promise<{ data: { id: string; name: string } }>;
  };

  /**
   * Nylas Threads API (v3) — the chosen label-apply mechanism (ADR §3, decision
   * (c) read-then-union). `find` reads the thread's current folder/label id set;
   * `update` writes it back. NOTE: `update.folders` OVERWRITES the thread's folder
   * set, so applyThreadLabel always passes the UNION of the existing folders + the
   * new label id — never the label alone (which would strip INBOX/SENT/…).
   * Optional on the interface so a fake without label support is unaffected.
   */
  threads?: {
    find(params: {
      identifier: string;
      threadId: string;
    }): Promise<{ data: { id: string; folders?: string[] } }>;
    update(params: {
      identifier: string;
      threadId: string;
      requestBody: { folders?: string[] };
    }): Promise<{ data: { id: string; folders?: string[] } }>;
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
