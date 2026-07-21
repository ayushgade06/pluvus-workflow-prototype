import type { Creator } from "../../db/schema.js";
import type {
  IEmailProvider,
  IThreadLabeler,
  EmailRecipient,
  EmailSendOptions,
} from "../../engine/providers.js";
import { MockEmailProvider } from "../../engine/providers.js";
import type { EmailDraft } from "../../engine/types.js";
import { logTrace } from "../../observability/logger.js";
import {
  getNylasClient,
  nylasGrantId,
  type NylasClientLike,
} from "./client.js";
import { plainTextToHtmlEmail } from "./emailFormatter.js";

// Gmail's READ-ONLY system labels — ones Gmail owns and rejects when a
// threads.update write-back tries to re-assert them (`unsupported Google label:
// SENT`, found in live testing). We exclude these from the label union; Gmail
// re-applies them itself, so the thread keeps them (non-destructive). We KEEP the
// user-modifiable system labels (INBOX, UNREAD, STARRED, IMPORTANT) and any user
// labels, and add ours. See applyLabelToThread().
const GMAIL_READONLY_SYSTEM_LABELS = new Set<string>([
  "SENT",
  "DRAFT",
  "CHAT",
  "SPAM",
  "TRASH",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

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

export class NylasEmailProvider implements IEmailProvider, IThreadLabeler {
  private readonly drafter = new MockEmailProvider();

  // Gmail Campaign Labels (§6.5) — process-lifetime label-name → folder/label id
  // cache, so we hit folders.list/create at most once per campaign per process.
  private readonly labelIdCache = new Map<string, string>();
  // In-flight resolutions for the SAME label name, so concurrent sends for a
  // brand-new campaign collapse to a SINGLE list/create (single-flight, §6.5).
  private readonly labelResolving = new Map<string, Promise<string | undefined>>();

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
    // Gmail Campaign Labels master switch (§8). Read ONCE at construction. Even
    // with a labeler provider present, no label is applied unless this is true —
    // lets us ship dark and flip on after the grant's mail-modify scope is
    // confirmed in the target environment. Defaults from GMAIL_LABELS_ENABLED.
    private readonly labelsEnabled: boolean =
      process.env["GMAIL_LABELS_ENABLED"] === "true",
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
    const replyToMessageId = options?.replyToExternalId || undefined;
    const baseRequestBody = {
      to,
      subject: draft.subject,
      body: plainTextToHtmlEmail(draft.body),
      ...(recipient?.replyTo ? { replyTo: [{ email: recipient.replyTo }] } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };

    try {
      return await this.dispatch({
        ...baseRequestBody,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
    } catch (err) {
      // E7 (creator deleted the email/thread, or the stored reply id is otherwise
      // stale): a threaded send can fail because the message we're replying to no
      // longer exists provider-side. Threading must never cost us delivery, so we
      // retry the SAME email ONCE as a NEW thread (drop replyToMessageId) and log.
      // This fallback fires ONLY when we actually attempted to thread — a
      // new-thread send that fails is a genuine outage and is rethrown unchanged,
      // so retries/alerting still see it (we never silently swallow a real
      // failure or double-send on the non-threaded path).
      if (!replyToMessageId) throw err;
      console.warn(
        `[nylas] threaded send failed (replyToMessageId=${replyToMessageId}); ` +
          `retrying as a new thread. ${err instanceof Error ? err.message : String(err)}`,
      );
      return await this.dispatch(baseRequestBody);
    }
  }

  /**
   * Perform one Nylas send and resolve the resulting thread id. Extracted so the
   * E7 retry-as-new-thread fallback in send() can re-issue the request with the
   * reply linkage dropped without duplicating the response handling.
   */
  private async dispatch(requestBody: {
    to: Array<{ email: string; name?: string }>;
    subject?: string;
    body?: string;
    replyTo?: Array<{ email: string; name?: string }>;
    replyToMessageId?: string;
    attachments?: Array<{ filename: string; contentType: string; content: string }>;
  }): Promise<{ messageId: string; threadId: string }> {
    const response = await this.client.messages.send({
      identifier: this.grantId,
      requestBody,
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
   * Resolve the RFC822 `Message-ID` header of a stored message (E6b — Gmail
   * deep-link). Fetches the message with `fields=include_headers` and returns the
   * `Message-ID` value with the surrounding angle brackets stripped (Gmail's
   * `#search/rfc822msgid:` operator wants the bare id). Best-effort: any failure
   * (fetch error, header absent) yields undefined so the caller omits the link.
   */
  async rfc822MessageId(externalMessageId: string): Promise<string | undefined> {
    if (!externalMessageId) return undefined;
    try {
      const fetched = await this.client.messages.find({
        identifier: this.grantId,
        messageId: externalMessageId,
        queryParams: { fields: "include_headers" },
      });
      const header = (fetched.data.headers ?? []).find(
        (h) => h.name.toLowerCase() === "message-id",
      );
      const raw = header?.value?.trim();
      if (!raw) return undefined;
      // Strip the RFC822 angle brackets: "<abc@mail.gmail.com>" → "abc@mail.gmail.com".
      return raw.replace(/^<|>$/g, "");
    } catch (err) {
      console.warn(
        `[nylas] could not resolve rfc822 Message-ID for ${externalMessageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
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

  // -------------------------------------------------------------------------
  // Gmail Campaign Labels — applyThreadLabel (IThreadLabeler, §6.6)
  // -------------------------------------------------------------------------
  // ALL Gmail/Nylas specifics for labeling live here, behind the engine's
  // IThreadLabeler seam. Contract (§6.4): NEVER throws, is a no-op when the flag
  // is off / inputs are missing, and applies the label to the WHOLE conversation
  // via read-then-union at the thread level (ADR §3, decision (c)).

  /**
   * Ensure `label` (`Pluvus/<name>`) exists (find-or-create) and apply it to the
   * thread. Best-effort: every failure is caught + logged; delivery already
   * succeeded, and a later send on the same thread self-heals the label.
   */
  async applyThreadLabel(threadId: string, label: string): Promise<void> {
    // No-op unless enabled AND the SDK surface is present. A read/send-only grant
    // or a client without the folders/threads surface must never crash a send.
    if (!this.labelsEnabled || !threadId || !label) {
      logTrace("label.skipped", {
        tag: "labels",
        threadId,
        label,
        reason: !this.labelsEnabled ? "flag_off" : !threadId ? "no_thread" : "no_label",
      });
      return;
    }
    if (!this.client.folders || !this.client.threads) {
      logTrace("label.skipped", { tag: "labels", threadId, label, reason: "no_sdk_surface" });
      return;
    }

    try {
      const labelId = await this.resolveLabelId(label);
      if (!labelId) {
        // resolveLabelId already logged the specific failure; nothing more to do.
        return;
      }
      await this.applyLabelToThread(threadId, label, labelId);
    } catch (err) {
      // Belt-and-suspenders: the helpers swallow their own errors, but a labeling
      // failure must NEVER surface to the (detached) caller.
      logTrace("label.apply_failed", {
        tag: "labels",
        threadId,
        label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve the Gmail folder/label id for `label`, find-or-create, race-safe
   * (§6.5). Returns undefined (never throws) when it cannot be resolved — the
   * caller then skips the apply for this send.
   *
   *   1. cache hit → return the stored id.
   *   2. cache miss → single-flight: if a resolution for this label is already in
   *      flight, await THAT promise; otherwise start one (list → find → create,
   *      with create-conflict recovery by re-reading the list).
   */
  private resolveLabelId(label: string): Promise<string | undefined> {
    const cached = this.labelIdCache.get(label);
    if (cached) {
      logTrace("label.resolve.cache_hit", { tag: "labels", label, labelId: cached });
      return Promise.resolve(cached);
    }

    const inFlight = this.labelResolving.get(label);
    if (inFlight) return inFlight;

    const resolution = this.resolveLabelIdUncached(label).finally(() => {
      // Always clear the in-flight entry; the cache (set on success) is the
      // durable store. A failed resolution leaves nothing cached → the next send
      // re-lists (self-healing).
      this.labelResolving.delete(label);
    });
    this.labelResolving.set(label, resolution);
    return resolution;
  }

  /** The actual list → find → create(+conflict-recover) work for one label. */
  private async resolveLabelIdUncached(label: string): Promise<string | undefined> {
    const folders = this.client.folders!;
    try {
      // List once, find by EXACT name (Gmail returns nested labels by full path).
      const listed = await folders.list({ identifier: this.grantId });
      logTrace("label.resolve.listed", { tag: "labels", label, count: listed.data.length });
      const existing = listed.data.find((f) => f.name === label);
      if (existing) {
        this.labelIdCache.set(label, existing.id);
        logTrace("label.reused_existing", {
          tag: "labels",
          label,
          labelId: existing.id,
          outcome: "existing",
        });
        return existing.id;
      }

      // Absent → create it. Gmail auto-materializes the `Pluvus` parent for a
      // full-path name (ADR §4), so one create is enough.
      try {
        const created = await folders.create({
          identifier: this.grantId,
          requestBody: { name: label },
        });
        this.labelIdCache.set(label, created.data.id);
        logTrace("label.created", {
          tag: "labels",
          label,
          labelId: created.data.id,
          outcome: "created",
        });
        return created.data.id;
      } catch (createErr) {
        // Create-conflict recovery (§6.5): the label was created concurrently (by
        // another process, or a race Nylas didn't collapse). Re-read the list and
        // use the now-existing label. Only give up if it STILL isn't found.
        const reread = await folders.list({ identifier: this.grantId });
        const recovered = reread.data.find((f) => f.name === label);
        if (recovered) {
          this.labelIdCache.set(label, recovered.id);
          logTrace("label.create_conflict.recovered", {
            tag: "labels",
            label,
            labelId: recovered.id,
            outcome: "recovered",
          });
          return recovered.id;
        }
        // Genuinely unresolvable — log and skip (delivery already succeeded).
        logTrace("label.apply_failed", {
          tag: "labels",
          label,
          error: createErr instanceof Error ? createErr.message : String(createErr),
          phase: "create",
        });
        return undefined;
      }
    } catch (listErr) {
      logTrace("label.apply_failed", {
        tag: "labels",
        label,
        error: listErr instanceof Error ? listErr.message : String(listErr),
        phase: "list",
      });
      return undefined;
    }
  }

  /**
   * Apply the resolved label id to the whole conversation via read-then-union at
   * the thread level (ADR §3): read the thread's current folder set, drop Gmail's
   * READ-ONLY system labels, and write back [remaining user/modifiable labels +
   * our label id]. Applying an already-present label is a no-op.
   *
   * Why the system-label filter (found in live testing): Gmail's threads.update
   * rejects a write-back that re-asserts an immutable system label — e.g. a thread
   * carrying "SENT" fails with `unsupported Google label: SENT`. Gmail owns those
   * labels and re-applies them itself, so we MUST exclude them from our write-back
   * (we still never strip them — Gmail keeps them). We keep INBOX/UNREAD/STARRED/
   * IMPORTANT and any user labels, and add ours.
   */
  private async applyLabelToThread(
    threadId: string,
    label: string,
    labelId: string,
  ): Promise<void> {
    const threads = this.client.threads!;
    try {
      const found = await threads.find({ identifier: this.grantId, threadId });
      const current = found.data.folders ?? [];
      if (current.includes(labelId)) {
        // Already labeled — self-healing no-op (a prior send applied it).
        logTrace("label.applied", {
          tag: "labels",
          threadId,
          label,
          labelId,
          outcome: "already_present",
        });
        return;
      }
      // Union = current folders MINUS Gmail's read-only system labels, PLUS ours.
      // Gmail re-adds the filtered system labels itself, so this is non-destructive.
      const writeBack = [
        ...current.filter((f) => !GMAIL_READONLY_SYSTEM_LABELS.has(f)),
        labelId,
      ];
      await threads.update({
        identifier: this.grantId,
        threadId,
        requestBody: { folders: writeBack },
      });
      logTrace("label.applied", {
        tag: "labels",
        threadId,
        label,
        labelId,
        outcome: "applied",
      });
    } catch (err) {
      logTrace("label.apply_failed", {
        tag: "labels",
        threadId,
        label,
        labelId,
        error: err instanceof Error ? err.message : String(err),
        phase: "apply",
      });
    }
  }
}
