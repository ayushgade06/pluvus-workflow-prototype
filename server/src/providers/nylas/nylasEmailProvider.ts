import type { Creator } from "../../db/schema.js";
import type {
  IEmailProvider,
  EmailRecipient,
  EmailSendOptions,
} from "../../engine/providers.js";
import { MockEmailProvider } from "../../engine/providers.js";
import type { EmailDraft } from "../../engine/types.js";
import {
  getNylasClient,
  nylasGrantId,
  type NylasClientLike,
} from "./client.js";
import { plainTextToHtmlEmail } from "./emailFormatter.js";

// ---------------------------------------------------------------------------
// NylasEmailProvider
// ---------------------------------------------------------------------------
// Real email provider backed by Nylas. Implements the SAME IEmailProvider
// interface as MockEmailProvider, so the WorkflowRuntime and every executor
// (initialOutreach / followUp / negotiation) use it without any change.
//
// - draft(): templating is identical to the mock for Phase 6. Real AI drafting
//   arrives in Phase 8 behind the IAgentProvider, not here.
// - send(): calls nylas.messages.send and maps the response to the existing
//   { messageId, threadId } contract. Those ids are persisted on Message by the
//   executors, which is exactly what lets the inbound webhook correlate replies
//   back to this instance by threadId.

export class NylasEmailProvider implements IEmailProvider {
  private readonly drafter = new MockEmailProvider();

  constructor(
    // Injectable for tests; defaults to the lazy SDK singleton.
    private readonly client: NylasClientLike = getNylasClient(),
    private readonly grantId: string = nylasGrantId(),
    // Base template for the operator-facing thread deep-link (E6, D4). Nylas has
    // no single canonical public per-thread web URL, and which inbox the operator
    // actually reads is a deployment decision — so the URL is built from a
    // configurable template rather than guessed. `{threadId}` (or a trailing
    // slash / no placeholder) is substituted with the thread id. Undefined when
    // NYLAS_THREAD_URL_TEMPLATE is unset → threadUrl() returns undefined and every
    // caller omits the link (graceful degradation, never a broken link).
    private readonly threadUrlTemplate: string | undefined =
      process.env["NYLAS_THREAD_URL_TEMPLATE"]?.trim() || undefined,
  ) {}

  // Drafting is unchanged from the mock for this phase — same subject/body
  // templating from creator profile + node config.
  async draft(
    creator: Creator,
    template: string,
    config: Record<string, unknown>,
  ): Promise<EmailDraft> {
    return this.drafter.draft(creator, template, config);
  }

  async send(
    draft: EmailDraft,
    creator: Creator,
    recipient?: EmailRecipient,
    options?: EmailSendOptions,
  ): Promise<{ messageId: string; threadId: string }> {
    // Presentation only: the draft body is authored as plain text, which Nylas
    // (rendering `body` as HTML) would otherwise collapse into one block. Wrap
    // it in minimal business-email HTML so it reads professionally. The wording
    // is unchanged, and the plain-text body is what was persisted upstream — we
    // only format the bytes that go over the wire.
    // Attachments (Content Brief PDF) are base64-encoded for the Nylas wire
    // format. Only Content Brief sets draft.attachments; for every other draft
    // this is undefined and the requestBody is byte-for-byte what it was before.
    const attachments = draft.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content.toString("base64"),
    }));

    // Address the explicit recipient (brand outbound) when supplied, otherwise
    // the creator whose thread we're on. An optional Reply-To is honored when set.
    const to = recipient
      ? [{ email: recipient.email, name: recipient.name }]
      : [{ email: creator.email, name: creator.name }];

    // Email Threading — E4 (ADR-3: the ONLY place the Nylas field name appears).
    // Map the transport-neutral `replyToExternalId` (this codebase's own term for
    // a stored provider message id) onto Nylas's native `replyToMessageId`. Per
    // E1/V1-V4: it is the message id we already persist as
    // `Message.externalMessageId`, it needs no translation, and setting it makes
    // Nylas thread the send AND auto-emit the RFC In-Reply-To/References headers —
    // so we never hand-roll those. Conditional spread (never
    // `replyToMessageId: undefined`) keeps the requestBody byte-for-byte identical
    // to today when no reply target is present → a brand-new thread, exactly as
    // before.
    const response = await this.client.messages.send({
      identifier: this.grantId,
      requestBody: {
        to,
        subject: draft.subject,
        body: plainTextToHtmlEmail(draft.body),
        ...(recipient?.replyTo ? { replyTo: [{ email: recipient.replyTo }] } : {}),
        ...(options?.replyToExternalId
          ? { replyToMessageId: options.replyToExternalId }
          : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
    });

    const { id } = response.data;
    const threadId = await this.resolveThreadId(id, response.data.threadId);

    return { messageId: id, threadId };
  }

  /**
   * Build the operator-facing deep-link to this thread (E6). Returns undefined
   * when no template is configured or the threadId is empty, so the escalation
   * email and Manual Queue row omit the link gracefully rather than render a
   * broken one. Pure (no I/O): substitutes the thread id into the configured
   * template — replacing a `{threadId}` placeholder when present, else appending
   * to the template (so both `https://host/threads/{threadId}` and
   * `https://host/threads/` styles work). The id is URL-encoded.
   */
  threadUrl(threadId: string): string | undefined {
    if (!this.threadUrlTemplate || !threadId) return undefined;
    const encoded = encodeURIComponent(threadId);
    if (this.threadUrlTemplate.includes("{threadId}")) {
      return this.threadUrlTemplate.replace(/\{threadId\}/g, encoded);
    }
    return `${this.threadUrlTemplate}${encoded}`;
  }

  /**
   * Resolve the real Nylas thread id for a just-sent message.
   *
   * Nylas frequently omits threadId on the immediate send response for a
   * brand-new thread. If we persisted `threadId = messageId` (the old fallback),
   * the creator's reply — which Nylas tags with the thread's *real* id — would
   * never match findMessagesByThreadId, so the inbound webhook would drop it as
   * "thread not found". We fetch the message back to read its authoritative
   * threadId so correlation works from the very first reply.
   *
   * If the send response already carried a threadId, we trust it and skip the
   * extra round-trip. If the follow-up fetch fails or still yields no threadId,
   * we fall back to the message id — no worse than before, and outbound still
   * succeeds.
   */
  private async resolveThreadId(
    messageId: string,
    threadIdFromSend: string | undefined,
  ): Promise<string> {
    if (threadIdFromSend) return threadIdFromSend;

    try {
      const fetched = await this.client.messages.find({
        identifier: this.grantId,
        messageId,
      });
      if (fetched.data.threadId) return fetched.data.threadId;
    } catch (err) {
      console.warn(
        `[nylas] could not resolve threadId for message ${messageId}; falling back to messageId. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return messageId;
  }
}
