// ---------------------------------------------------------------------------
// Creator import row preparation (PLU-109)
// ---------------------------------------------------------------------------
// Turns parsed records into upsertable creator inserts, reporting per-row why a
// row could not be imported instead of failing the whole batch. Pure — no DB,
// no Express — so the whole contract is unit-testable.

import type { CreatorInsert, InputJsonValue } from "../db/schema.js";
import { normalizeEmail } from "../db/creators.js";
import { mapCreatorRow, type MappedCreatorRow } from "./creatorFields.js";

// Deliberately permissive — we want to accept the messy real-world addresses a
// vendor export carries, only rejecting clearly-not-an-email values. One @,
// non-empty local + domain parts, a dot in the domain.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PreparedRow {
  /** 1-based CSV data-row index (row 1 = the first row after the header). */
  rowNumber: number;
  /** The original cells, retained on the member row for later diagnosis. */
  raw: Record<string, string>;
  /** Null when the row cannot be imported; see errorReason. */
  insert: CreatorInsert | null;
  errorReason: string | null;
  /** The mapped view, for building the preview without re-mapping. */
  mapped: MappedCreatorRow;
}

function jsonOrUndefined(v: unknown): InputJsonValue | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as InputJsonValue) : undefined;
}

/** Build the insert for one already-validated mapped row. */
export function toCreatorInsert(mapped: MappedCreatorRow, email: string): CreatorInsert {
  // Fall back to the email local-part so a roster row is never blank.
  const name = mapped.name?.trim() || email.split("@")[0]!;
  return {
    email,
    name,
    handle: mapped.handle,
    platform: mapped.platform,
    niche: mapped.niche,
    profileUrl: mapped.profileUrl,
    followerCount: mapped.followerCount,
    engagementRate: mapped.engagementRate,
    location: mapped.location,
    language: mapped.language,
    bio: mapped.bio,
    ...(jsonOrUndefined(mapped.metadata) !== undefined
      ? { metadata: jsonOrUndefined(mapped.metadata) }
      : {}),
    ...(jsonOrUndefined(mapped.socialLinks) !== undefined
      ? { socialLinks: jsonOrUndefined(mapped.socialLinks) }
      : {}),
    ...(jsonOrUndefined(mapped.platformStats) !== undefined
      ? { platformStats: jsonOrUndefined(mapped.platformStats) }
      : {}),
    ...(jsonOrUndefined(mapped.signals) !== undefined
      ? { signals: jsonOrUndefined(mapped.signals) }
      : {}),
  };
}

/**
 * Prepare every parsed record for import.
 *
 * Three ways a row is rejected, each reported with its 1-based row number so
 * the operator can find it in the source file:
 *   - no email at all
 *   - an email that is not plausibly an address
 *   - an email already used by an EARLIER row in the same file
 *
 * The in-file duplicate check is why this returns rows rather than a filtered
 * list: the second occurrence must still be recorded, so "3 skipped" can be
 * explained rather than just asserted.
 */
export function prepareRows(records: Array<Record<string, string>>): PreparedRow[] {
  const seenEmails = new Map<string, number>();
  const out: PreparedRow[] = [];

  records.forEach((raw, i) => {
    const rowNumber = i + 1;
    const mapped = mapCreatorRow(raw);
    const base = { rowNumber, raw, mapped };

    const rawEmail = mapped.email.trim();
    if (!rawEmail) {
      out.push({ ...base, insert: null, errorReason: "missing email" });
      return;
    }
    if (!EMAIL_RE.test(rawEmail)) {
      out.push({ ...base, insert: null, errorReason: `invalid email "${rawEmail}"` });
      return;
    }

    const email = normalizeEmail(rawEmail);
    const firstSeen = seenEmails.get(email);
    if (firstSeen !== undefined) {
      out.push({
        ...base,
        insert: null,
        errorReason: `duplicate of row ${firstSeen} (${email})`,
      });
      return;
    }
    seenEmails.set(email, rowNumber);

    out.push({ ...base, insert: toCreatorInsert(mapped, email), errorReason: null });
  });

  return out;
}
