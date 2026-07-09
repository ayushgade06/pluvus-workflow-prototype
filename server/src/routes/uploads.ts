import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { saveUploadedFile } from "../storage/localFileStorage.js";

// ---------------------------------------------------------------------------
// Uploads (Phase 16 — Content Brief)
// ---------------------------------------------------------------------------
// POST /uploads — accepts a single multipart file field named "file", stores it
// via the local file-storage seam, and returns the reference the builder should
// persist in node config. This is the ONLY place the raw bytes touch the API;
// the workflow architecture only ever sees the returned reference string.
//
// Kept deliberately generic (not "brief-specific") so the same endpoint can back
// any future brand upload. Swap localFileStorage for a cloud backend and this
// route is unchanged.

const router = Router();

// In-memory storage: the file lands in req.file.buffer, which we hand to the
// storage seam. For the prototype's small PDFs this avoids a temp-file dance;
// the 10 MB cap keeps memory bounded. A cloud backend would stream instead.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — plenty for a brief PDF.
});

// MED-S3: the real PDF header. A PDF file MUST begin with "%PDF-" (bytes 25 50
// 44 46 2D) followed by a version. The extension + mimetype are attacker- or
// browser-controlled and prove nothing about the CONTENT; without a content
// check, an unvalidated file (an HTML page, a script, or garbage) named ".pdf"
// could be stored and later EMAILED to creators as the brand's official brief.
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

/** True when the file's bytes actually begin with the %PDF- signature. */
export function hasPdfMagicBytes(buffer: Buffer): boolean {
  // Compare only the first 5 bytes; a valid PDF header is at offset 0 per spec.
  return buffer.length >= PDF_MAGIC.length && buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

function isPdf(file: Express.Multer.File): boolean {
  const nameIsPdf = /\.pdf$/i.test(file.originalname);
  const mimeIsPdf = file.mimetype === "application/pdf";
  // Require the extension; accept the common PDF mimetype OR a generic
  // octet-stream (some browsers/tools omit the precise type). AND require the
  // actual %PDF- magic bytes (MED-S3) — extension/mime alone are not evidence of
  // real PDF content, and this file is later emailed to creators as the brief.
  return (
    nameIsPdf &&
    (mimeIsPdf || file.mimetype === "application/octet-stream") &&
    hasPdfMagicBytes(file.buffer)
  );
}

// POST /uploads — store one PDF and return its reference.
router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "no file provided (expected multipart field 'file')" });
      return;
    }
    if (!isPdf(file)) {
      res.status(400).json({ error: "only PDF files are accepted" });
      return;
    }

    const stored = await saveUploadedFile(file.buffer, file.originalname);
    res.status(201).json({
      reference: stored.reference,
      originalName: stored.originalName,
      size: file.size,
    });
  } catch (err) {
    console.error("[uploads] error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
