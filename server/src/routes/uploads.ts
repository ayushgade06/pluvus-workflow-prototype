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

function isPdf(file: Express.Multer.File): boolean {
  const nameIsPdf = /\.pdf$/i.test(file.originalname);
  const mimeIsPdf = file.mimetype === "application/pdf";
  // Require the extension; accept the common PDF mimetype OR a generic
  // octet-stream (some browsers/tools omit the precise type).
  return nameIsPdf && (mimeIsPdf || file.mimetype === "application/octet-stream");
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
