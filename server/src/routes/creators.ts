// ---------------------------------------------------------------------------
// Creator routes
// ---------------------------------------------------------------------------
// Roster surface for the enrollment UI:
//
//   GET  /creators        list all creators (name, email, handle, audience, …)
//   POST /creators        add ONE creator by hand
//
// Bulk CSV import lives in routes/creatorImports.ts (POST /creators/imports).
// It replaced the old JSON-body POST /creators/import, which sent the entire
// parsed file through express.json() — whose 100 kb default meant any import
// beyond a few hundred rows failed with a 413. The import path is multipart and
// two-phase (upload → preview → commit); this file keeps only the roster read
// and the single-creator add, which the inline "Add creator" form uses.

import { Router } from "express";
import type { Request, Response } from "express";
import { deleteCreators, listCreators, upsertCreatorByEmail } from "../db/creators.js";
import { stripAt } from "../validation/creatorFields.js";
import { EMAIL_RE } from "../validation/creatorImport.js";
import { toCreatorDto } from "./creatorDto.js";

const router = Router();

function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// GET /creators — list all creators for the enrollment UI
// ---------------------------------------------------------------------------

router.get("/", async (_req: Request, res: Response) => {
  try {
    const creators = await listCreators();
    res.json(creators.map(toCreatorDto));
  } catch (err) {
    console.error("[creators] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /creators — add a single creator by hand
// ---------------------------------------------------------------------------
// Upserts on email, so re-adding an existing address enriches that creator
// rather than erroring or duplicating them.

router.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const email = cleanStr(body["email"]);
    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: `invalid email "${email}"` });
      return;
    }

    // normalizeEmail is applied inside upsertCreatorByEmail, so the DB's
    // case-sensitive unique index and our identity key stay in agreement.
    const creator = await upsertCreatorByEmail({
      email,
      name: cleanStr(body["name"]) ?? email.split("@")[0]!,
      // stripAt so a hand-typed "@ada" is stored the same way the CSV path
      // stores it — otherwise the same creator has two different handles
      // depending on how they were added.
      handle: stripAt(cleanStr(body["handle"])),
      platform: cleanStr(body["platform"]),
      niche: cleanStr(body["niche"]),
      profileUrl: cleanStr(body["profileUrl"]),
    });

    res.status(201).json({ creator: toCreatorDto(creator) });
  } catch (err) {
    console.error("[creators] create error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /creators/delete — remove creators from the roster
// ---------------------------------------------------------------------------
// Body: { creatorIds: string[] }  →  { deleted: string[], blocked: [...] }
//
// POST rather than DELETE /creators/:id for two reasons: a request body on
// DELETE is unevenly supported, and the bulk case needs PARTIAL-failure
// reporting, which a 204/409 cannot express. The row-level trash button sends an
// array of one, so the guard in deleteCreators has exactly one code path.
//
// A creator who is enrolled or partnered is kept and reported — see
// deleteCreators for why that must never become a cascade.

router.post("/delete", async (req: Request, res: Response) => {
  const { creatorIds } = req.body as { creatorIds?: unknown };
  if (!Array.isArray(creatorIds) || creatorIds.length === 0) {
    res.status(400).json({ error: "creatorIds must be a non-empty array" });
    return;
  }

  try {
    const ids = creatorIds.filter((id): id is string => typeof id === "string" && !!id);
    const { deleted, blocked } = await deleteCreators(ids);
    res.json({ deleted, blocked, deletedCount: deleted.length, blockedCount: blocked.length });
  } catch (err) {
    console.error("[creators] delete error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
