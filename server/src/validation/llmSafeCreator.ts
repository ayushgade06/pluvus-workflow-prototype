// ---------------------------------------------------------------------------
// LLM-safe creator context (PLU-109)
// ---------------------------------------------------------------------------
// The CSV import accepts creator-discovery vendor exports that carry fields no
// model provider should ever see:
//
//   - contact_phone_number  → direct PII for a person who has not yet agreed to
//                             anything with the brand
//   - onlyfans_*            → adult-platform presence
//   - gender                → present in the vendor file; not a basis for
//                             targeting or personalization
//
// Storing them is legitimate (they are CRM data the operator paid for and may
// need for brand-safety filtering). SENDING them to an LLM is not, and the
// creator never consented to it.
//
// This module is an ALLOWLIST, deliberately — a denylist silently fails open
// the moment someone adds a column. Everything reaching a drafting prompt must
// pass through here, so widening the payload is an explicit, reviewable edit
// rather than an accident.
//
// The single choke point is buildDraftRequest in engine/providerFactory.ts.

import type { Creator } from "../db/schema.js";

/**
 * The ONLY creator fields permitted to reach a model provider.
 *
 * Adding to this list is a privacy decision — it means that value will be
 * transmitted to a third-party LLM for every creator in every campaign. The
 * test in llmSafeCreator.test.ts asserts the exact contents of this set, so
 * broadening it cannot pass review unnoticed.
 */
export const LLM_SAFE_CREATOR_FIELDS = [
  "name",
  "platform",
  "niche",
  "handle",
  "bio",
] as const;

export type LlmSafeCreatorField = (typeof LLM_SAFE_CREATOR_FIELDS)[number];

export type LlmSafeCreatorContext = {
  [K in LlmSafeCreatorField]?: string | undefined;
};

/**
 * Project a Creator down to the fields that may be sent to an LLM.
 *
 * Note the whole-object fields that are structurally excluded: `email` (the
 * address is used to SEND the mail, never to write it), `metadata` and
 * `signals` (raw vendor columns — the phone number and onlyfans_* data live
 * here), `socialLinks`, `platformStats`, `location`, `language`, and the
 * audience numbers. If a prompt genuinely needs one of those, add it above
 * explicitly and take the privacy decision on purpose.
 */
export function llmSafeCreatorContext(creator: Creator): LlmSafeCreatorContext {
  const out: LlmSafeCreatorContext = {};
  for (const field of LLM_SAFE_CREATOR_FIELDS) {
    const value = (creator as Record<string, unknown>)[field];
    if (typeof value === "string" && value.trim().length > 0) {
      out[field] = value;
    }
  }
  return out;
}
