import type { Creator } from "@prisma/client";
import type { IEmailProvider } from "../../engine/providers.js";
import { MockEmailProvider } from "../../engine/providers.js";
import type { EmailDraft } from "../../engine/types.js";
import {
  getNylasClient,
  nylasGrantId,
  type NylasClientLike,
} from "./client.js";

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
  ): Promise<{ messageId: string; threadId: string }> {
    const response = await this.client.messages.send({
      identifier: this.grantId,
      requestBody: {
        to: [{ email: creator.email, name: creator.name }],
        subject: draft.subject,
        body: draft.body,
      },
    });

    const { id, threadId } = response.data;
    return {
      messageId: id,
      // Nylas may omit threadId on the immediate send response for a brand-new
      // thread; fall back to the message id so the Message row still carries a
      // stable, unique correlation key.
      threadId: threadId ?? id,
    };
  }
}
