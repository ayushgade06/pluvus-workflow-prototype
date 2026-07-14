// ---------------------------------------------------------------------------
// Creator routes
// ---------------------------------------------------------------------------
// Roster surface for the enrollment UI:
//
//   GET  /creators          list all creators (name, email, handle, …)
//   POST /creators/import    bulk-create creators from parsed CSV rows
//
// The import endpoint is the server half of the "upload a CSV" flow: the client
// parses the file, maps headers, and POSTs clean JSON rows. We validate each
// row's email, upsert the valid ones (enriching existing records on re-upload),
// and return the resulting creators so the UI can pre-select them. Invalid rows
// are reported back per-row rather than failing the whole batch.

import { Router } from "express";
import type { Request, Response } from "express";
import type { CreatorInsert, InputJsonValue } from "../db/schema.js";
import { listCreators, bulkUpsertCreators } from "../db/creators.js";

const router = Router();

interface CreatorDto {
  id: string;
  name: string;
  email: string;
  handle: string | null;
  platform: string | null;
  niche: string | null;
}

function toDto(c: {
  id: string;
  name: string;
  email: string;
  handle: string | null;
  platform: string | null;
  niche: string | null;
}): CreatorDto {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    handle: c.handle,
    platform: c.platform,
    niche: c.niche,
  };
}

// Deliberately permissive — we want to accept the messy real-world addresses a
// CSV carries, only rejecting clearly-not-an-email values. One @, non-empty
// local + domain parts, a dot in the domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

interface RawRow {
  email?: unknown;
  name?: unknown;
  handle?: unknown;
  platform?: unknown;
  niche?: unknown;
  metadata?: unknown;
}

export interface ValidatedImport {
  valid: CreatorInsert[];
  errors: Array<{ row: number; reason: string }>;
}

/**
 * Validate raw import rows into upsertable creator inputs. Pure — no DB, no
 * Express — so it's unit-testable in isolation. Each bad row is reported with a
 * 1-based index rather than failing the batch; a missing name falls back to the
 * email local-part; unrecognized `metadata` objects are attached as-is.
 */
export function validateImportRows(rows: unknown[]): ValidatedImport {
  const valid: CreatorInsert[] = [];
  const errors: Array<{ row: number; reason: string }> = [];

  rows.forEach((raw, i) => {
    const rowNum = i + 1;
    const r = (raw ?? {}) as RawRow;
    const email = cleanStr(r.email);
    if (!email) {
      errors.push({ row: rowNum, reason: "missing email" });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      errors.push({ row: rowNum, reason: `invalid email "${email}"` });
      return;
    }
    // Fall back to the email local-part so a roster row is never blank.
    const name = cleanStr(r.name) ?? email.split("@")[0]!;
    const metadata =
      r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
        ? (r.metadata as InputJsonValue)
        : undefined;

    valid.push({
      email,
      name,
      handle: cleanStr(r.handle),
      platform: cleanStr(r.platform),
      niche: cleanStr(r.niche),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  });

  return { valid, errors };
}

// ---------------------------------------------------------------------------
// GET /creators — list all creators for the enrollment UI
// ---------------------------------------------------------------------------

router.get("/", async (_req: Request, res: Response) => {
  try {
    const creators = await listCreators();
    res.json(creators.map(toDto));
  } catch (err) {
    console.error("[creators] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /creators/import — bulk-create creators from parsed CSV rows
// ---------------------------------------------------------------------------
// Body: { rows: Array<{ email, name?, handle?, platform?, niche?, metadata? }> }
// Returns: { created, updated, skipped, errors, creators }
//   - created/updated: counts from the upsert (deduped on email)
//   - skipped: rows dropped for a bad/missing email
//   - errors: [{ row, reason }] for each skipped row (row = 1-based CSV index)
//   - creators: the full set of upserted creators (for pre-selection in the UI)

router.post("/import", async (req: Request, res: Response) => {
  const { rows } = req.body as { rows?: unknown };
  if (!Array.isArray(rows)) {
    res.status(400).json({ error: "rows must be an array" });
    return;
  }
  if (rows.length === 0) {
    res.status(400).json({ error: "rows must be a non-empty array" });
    return;
  }

  const { valid, errors } = validateImportRows(rows);

  if (valid.length === 0) {
    res.status(422).json({
      error: "no valid rows to import",
      created: 0,
      updated: 0,
      skipped: errors.length,
      errors,
      creators: [],
    });
    return;
  }

  try {
    const { creators, created, updated } = await bulkUpsertCreators(valid);
    res.json({
      created,
      updated,
      skipped: errors.length,
      errors,
      creators: creators.map(toDto),
    });
  } catch (err) {
    console.error("[creators] import error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
