// ---------------------------------------------------------------------------
// Creator import routes (PLU-109)
// ---------------------------------------------------------------------------
//
//   POST   /creators/imports              upload a CSV → DRAFT batch + preview
//   GET    /creators/imports              batches for the source-list dropdown
//   GET    /creators/imports/:id          batch detail + members + creators
//   POST   /creators/imports/:id/commit   upsert the creators, finalize counts
//   DELETE /creators/imports/:id          discard a draft (batch + stored file)
//   PATCH  /creators/imports/:id          rename a label / archive a batch
//   GET    /creators/imports/:id/file     re-download the original upload
//
// TWO-PHASE ON PURPOSE. The upload parses and validates but writes nothing to
// Creator; it returns a preview ("142 rows · 118 new · 21 already in your
// roster · 3 skipped") that the operator confirms before anything is committed.
// When you are pasting in 500 unfamiliar rows, seeing what WILL happen matters
// more than saving a round trip.
//
// MULTIPART, not a JSON body. The previous JSON endpoint sent the whole parsed
// file through express.json(), whose 100 kb default meant any import beyond a
// few hundred rows died with a 413 — the feature did not survive its own use
// case. Multipart also hands us the raw bytes to retain, in the same request.

import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import {
  commitBatch,
  createBatch,
  deleteBatch,
  findBatchById,
  findOtherBatchLabels,
  insertMembers,
  listBatches,
  listMembers,
  listMembersWithCreators,
  updateBatch,
  type MemberOutcomeUpdate,
} from "../db/creatorImportBatches.js";
import { bulkUpsertCreators, normalizeEmail } from "../db/creators.js";
import { db } from "../db/drizzle.js";
import {
  creators as creatorsTable,
  type CreatorImportBatch,
  type CreatorInsert,
} from "../db/schema.js";
import { inArray } from "drizzle-orm";
import {
  deleteStoredFile,
  readStoredFile,
  saveUploadedFile,
} from "../storage/localFileStorage.js";
import { hasEmailColumn } from "../validation/creatorFields.js";
import { prepareRows, toCreatorInsert } from "../validation/creatorImport.js";
import { parseDelimited } from "../validation/parseCsv.js";
import { toCreatorDto, type CreatorDto } from "./creatorDto.js";

const router = Router();

// A vendor export runs ~80 columns wide, so 5,000 rows is roughly 5 MB. 25 MB
// leaves real headroom. The brief-PDF route keeps its own tighter 10 MB cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Rows returned in the draft preview. Enough to eyeball, not the whole file. */
const PREVIEW_ROW_LIMIT = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accept a delimited-text upload.
 *
 * Extension and mimetype are client-controlled and prove nothing, so the real
 * check is that the bytes decode as UTF-8 text and parse into a header row with
 * a recognisable email column — which the caller does immediately after. Here we
 * only reject content that is obviously binary, so an image renamed to .csv
 * fails with a clear message instead of a confusing parse error.
 */
function looksLikeText(buffer: Buffer): boolean {
  // A NUL byte in the first 8 kB means binary; no text encoding we accept has one.
  return !buffer.subarray(0, 8192).includes(0);
}

/** "influencers.csv" + 2026-07-21 → "Jul 21 · influencers.csv" */
function defaultLabel(filename: string, now: Date): string {
  const stamp = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${stamp} · ${filename}`;
}

interface BatchDto {
  id: string;
  label: string;
  sourceFilename: string;
  status: string;
  delimiter: string | null;
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  hasFile: boolean;
  createdAt: string;
  committedAt: string | null;
}

function toBatchDto(b: CreatorImportBatch): BatchDto {
  return {
    id: b.id,
    label: b.label,
    sourceFilename: b.sourceFilename,
    status: b.status,
    delimiter: b.delimiter,
    rowCount: b.rowCount,
    createdCount: b.createdCount,
    updatedCount: b.updatedCount,
    skippedCount: b.skippedCount,
    hasFile: !!b.fileReference,
    createdAt: b.createdAt.toISOString(),
    committedAt: b.committedAt ? b.committedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// POST /creators/imports — upload + parse + preview (writes NO creators)
// ---------------------------------------------------------------------------

router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "no file provided (expected multipart field 'file')" });
      return;
    }
    if (!looksLikeText(file.buffer)) {
      res.status(400).json({ error: "that file is not text — expected a CSV or TSV export" });
      return;
    }

    const text = file.buffer.toString("utf8");
    const { headers, records, delimiter, rowCount } = parseDelimited(text);

    if (headers.length === 0 || rowCount === 0) {
      res.status(400).json({ error: "that file has no data rows" });
      return;
    }
    if (!hasEmailColumn(headers)) {
      // Reject the whole file up front rather than importing a batch of blanks.
      res.status(400).json({
        error:
          'no email column found — the file needs a column named "email" (or "email_address" / "e-mail")',
        headers,
      });
      return;
    }

    const prepared = prepareRows(records);
    const valid = prepared.filter((p) => p.insert !== null);

    // Which of these emails the roster already knows, so the preview can say
    // "118 new · 21 already in your roster" BEFORE anything is written.
    const emails = valid.map((p) => normalizeEmail(p.insert!.email));
    const existing = new Set<string>();
    if (emails.length > 0) {
      for (let i = 0; i < emails.length; i += 500) {
        const part = emails.slice(i, i + 500);
        const found = await db
          .select({ email: creatorsTable.email })
          .from(creatorsTable)
          .where(inArray(creatorsTable.email, part));
        for (const r of found) existing.add(r.email.toLowerCase());
      }
    }

    const stored = await saveUploadedFile(file.buffer, file.originalname);

    const label =
      typeof req.body?.label === "string" && req.body.label.trim()
        ? req.body.label.trim()
        : defaultLabel(file.originalname, new Date());

    const batch = await createBatch({
      label,
      sourceFilename: file.originalname,
      fileReference: stored.reference,
      delimiter,
      status: "DRAFT",
      rowCount,
      skippedCount: prepared.length - valid.length,
    });

    await insertMembers(
      prepared.map((p) => ({
        batchId: batch.id,
        rowNumber: p.rowNumber,
        outcome: p.insert ? ("PENDING" as const) : ("SKIPPED" as const),
        errorReason: p.errorReason,
        rawRow: p.raw,
      })),
    );

    const newCount = valid.filter(
      (p) => !existing.has(normalizeEmail(p.insert!.email)),
    ).length;

    res.status(201).json({
      batch: toBatchDto(batch),
      headers,
      delimiter,
      rowCount,
      validCount: valid.length,
      newCount,
      existingCount: valid.length - newCount,
      skippedCount: prepared.length - valid.length,
      errors: prepared
        .filter((p) => p.errorReason)
        .map((p) => ({ row: p.rowNumber, reason: p.errorReason! })),
      // A sample to eyeball before committing — not the whole file.
      preview: valid.slice(0, PREVIEW_ROW_LIMIT).map((p) => ({
        row: p.rowNumber,
        email: p.insert!.email,
        name: p.insert!.name,
        handle: p.insert!.handle ?? null,
        platform: p.insert!.platform ?? null,
        niche: p.insert!.niche ?? null,
        followerCount: p.insert!.followerCount ?? null,
        engagementRate: p.insert!.engagementRate ?? null,
        isNew: !existing.has(normalizeEmail(p.insert!.email)),
      })),
    });
  } catch (err) {
    console.error("[creatorImports] upload error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /creators/imports/:id/commit — write the creators
// ---------------------------------------------------------------------------

router.post("/:id/commit", async (req: Request, res: Response) => {
  try {
    const batch = await findBatchById(req.params["id"]!);
    if (!batch) {
      res.status(404).json({ error: "import batch not found" });
      return;
    }
    if (batch.status !== "DRAFT") {
      // Committing twice would double-count and re-stamp outcomes.
      res.status(409).json({ error: `batch is already ${batch.status.toLowerCase()}` });
      return;
    }

    const members = await listMembers(batch.id);
    const pending = members.filter((m) => m.outcome === "PENDING");

    if (pending.length === 0) {
      const finalized = await commitBatch(batch.id, [], {
        createdCount: 0,
        updatedCount: 0,
        skippedCount: members.length,
      });
      res.json({ batch: toBatchDto(finalized), created: 0, updated: 0, creators: [] });
      return;
    }

    // Re-derive the inserts from the retained rawRow. Re-mapping rather than
    // trusting a client payload keeps the commit faithful to the file that was
    // actually uploaded and reviewed.
    const inserts: CreatorInsert[] = [];
    const rowByEmail = new Map<string, number>();
    for (const m of pending) {
      const raw = (m.rawRow ?? {}) as Record<string, string>;
      const prepared = prepareRows([raw])[0]!;
      if (!prepared.insert) continue;
      const email = normalizeEmail(prepared.insert.email);
      inserts.push(toCreatorInsert(prepared.mapped, email));
      rowByEmail.set(email, m.rowNumber);
    }

    const { creators, created, updated, existingEmails } = await bulkUpsertCreators(inserts);

    const updates: MemberOutcomeUpdate[] = [];
    for (const c of creators) {
      const email = c.email.toLowerCase();
      const rowNumber = rowByEmail.get(email);
      if (rowNumber === undefined) continue;
      updates.push({
        rowNumber,
        creatorId: c.id,
        outcome: existingEmails.has(email) ? "UPDATED" : "CREATED",
      });
    }

    const finalized = await commitBatch(batch.id, updates, {
      createdCount: created,
      updatedCount: updated,
      skippedCount: members.length - pending.length,
    });

    res.json({
      batch: toBatchDto(finalized),
      created,
      updated,
      creators: creators.map(toCreatorDto),
    });
  } catch (err) {
    console.error("[creatorImports] commit error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /creators/imports — the source-list dropdown
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response) => {
  try {
    const includeArchived = req.query["includeArchived"] === "true";
    const batches = await listBatches({ includeArchived });
    res.json(batches.map(toBatchDto));
  } catch (err) {
    console.error("[creatorImports] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /creators/imports/:id — members + creators + duplicate provenance
// ---------------------------------------------------------------------------

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const batch = await findBatchById(req.params["id"]!);
    if (!batch) {
      res.status(404).json({ error: "import batch not found" });
      return;
    }

    const rows = await listMembersWithCreators(batch.id);
    const creatorIds = rows
      .map((r) => r.creator?.id)
      .filter((id): id is string => !!id);
    const otherLabels = await findOtherBatchLabels(creatorIds, batch.id);

    res.json({
      batch: toBatchDto(batch),
      members: rows.map(({ member, creator }) => ({
        rowNumber: member.rowNumber,
        outcome: member.outcome,
        errorReason: member.errorReason,
        creator: creator ? toCreatorDto(creator) : null,
        // Which OTHER committed lists this creator also appears in — the
        // "also in Jul 20 list" badge.
        alsoInBatches: creator ? (otherLabels.get(creator.id) ?? []) : [],
      })),
    });
  } catch (err) {
    console.error("[creatorImports] detail error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /creators/imports/:id/file — re-download the original upload
// ---------------------------------------------------------------------------

router.get("/:id/file", async (req: Request, res: Response) => {
  try {
    const batch = await findBatchById(req.params["id"]!);
    if (!batch) {
      res.status(404).json({ error: "import batch not found" });
      return;
    }
    if (!batch.fileReference) {
      res.status(404).json({ error: "no stored file for this batch" });
      return;
    }

    const bytes = await readStoredFile(batch.fileReference);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${batch.sourceFilename.replace(/"/g, "")}"`,
    );
    res.send(bytes);
  } catch (err) {
    console.error("[creatorImports] file error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /creators/imports/:id — rename or archive
// ---------------------------------------------------------------------------

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const batch = await findBatchById(req.params["id"]!);
    if (!batch) {
      res.status(404).json({ error: "import batch not found" });
      return;
    }

    const { label, archived } = req.body as { label?: unknown; archived?: unknown };
    const patch: Parameters<typeof updateBatch>[1] = {};

    if (typeof label === "string") {
      const trimmed = label.trim();
      if (!trimmed) {
        res.status(400).json({ error: "label cannot be empty" });
        return;
      }
      patch.label = trimmed;
    }
    if (typeof archived === "boolean") {
      // Archiving hides the list from the picker; the audit trail and every
      // creator it introduced are untouched.
      patch.status = archived ? "ARCHIVED" : "COMMITTED";
      patch.archivedAt = archived ? new Date() : null;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "nothing to update (expected label or archived)" });
      return;
    }

    const updated = await updateBatch(batch.id, patch);
    res.json({ batch: toBatchDto(updated!) });
  } catch (err) {
    console.error("[creatorImports] patch error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /creators/imports/:id — discard a draft
// ---------------------------------------------------------------------------
// Only a DRAFT may be deleted. A committed batch is an audit record of creators
// that now exist in the roster; hiding it is what `archived` is for.

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const batch = await findBatchById(req.params["id"]!);
    if (!batch) {
      res.status(404).json({ error: "import batch not found" });
      return;
    }
    if (batch.status !== "DRAFT") {
      res.status(409).json({
        error: "only a draft import can be discarded — archive a committed batch instead",
      });
      return;
    }

    if (batch.fileReference) await deleteStoredFile(batch.fileReference);
    await deleteBatch(batch.id);
    res.status(204).end();
  } catch (err) {
    console.error("[creatorImports] delete error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
export type { BatchDto, CreatorDto };
