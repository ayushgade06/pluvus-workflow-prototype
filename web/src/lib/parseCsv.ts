// ---------------------------------------------------------------------------
// Minimal CSV parser for the creator-import flow (client-side)
// ---------------------------------------------------------------------------
// Hand-rolled to avoid a dependency. Handles the CSV features a real-world
// contact export actually uses:
//   - quoted fields:            "Doe, Jane"
//   - escaped quotes in quotes: "She said ""hi"""
//   - newlines inside quotes:   "line1\nline2"
//   - CRLF or LF line endings
//   - a BOM at the start of the file
//
// It maps a fixed set of known headers (case/space-insensitive) onto
// CreatorImportRow fields and folds every other column into `metadata` so no
// CSV data is silently dropped. `email` is required per row; rows without one
// still come back (with email: "") and are reported by the caller/server.

import type { CreatorImportRow } from "../api/builderTypes";

export interface ParseCsvResult {
  rows: CreatorImportRow[];
  /** Original header names, in file order (for diagnostics / preview). */
  headers: string[];
  /** True if no `email`-like column was found in the header. */
  missingEmailColumn: boolean;
}

// Known target fields → the header aliases that map onto them. Matching is done
// against a normalized header (lowercased, spaces/underscores stripped).
const FIELD_ALIASES: Record<keyof Omit<CreatorImportRow, "metadata">, string[]> = {
  email: ["email", "emailaddress", "e-mail", "mail"],
  name: ["name", "fullname", "creatorname", "displayname"],
  handle: ["handle", "username", "user", "instagramhandle", "tiktokhandle", "@"],
  platform: ["platform", "channel", "network", "socialplatform"],
  niche: ["niche", "category", "vertical", "topic"],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_\-]/g, "").trim();
}

// Build a normalized-alias → field lookup once.
const ALIAS_TO_FIELD = new Map<string, keyof Omit<CreatorImportRow, "metadata">>();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_FIELD.set(normalizeHeader(alias), field as keyof Omit<CreatorImportRow, "metadata">);
  }
}

/**
 * Tokenize CSV text into a matrix of string cells. RFC-4180-ish: quotes wrap
 * fields, "" is a literal quote, delimiters/newlines inside quotes are literal.
 */
function tokenize(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // Handle CRLF as a single line break.
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Flush the trailing field/row (file not ending in a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** True if a matrix row is entirely empty (blank line). */
function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c.trim() === "");
}

/**
 * Parse CSV text into CreatorImportRow[]. Returns rows in file order; the caller
 * (and the server) is responsible for validating that each email is present and
 * well-formed. Empty lines are skipped.
 */
export function parseCsv(text: string): ParseCsvResult {
  const matrix = tokenize(text).filter((r) => !isBlankRow(r));
  if (matrix.length === 0) {
    return { rows: [], headers: [], missingEmailColumn: true };
  }

  const headers = matrix[0]!.map((h) => h.trim());

  // Resolve each column index to either a known field or a metadata key.
  const columns = headers.map((h) => {
    const field = ALIAS_TO_FIELD.get(normalizeHeader(h));
    return { header: h, field: field ?? null };
  });

  const missingEmailColumn = !columns.some((c) => c.field === "email");

  const rows: CreatorImportRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r]!;
    const row: CreatorImportRow = { email: "" };
    const metadata: Record<string, string> = {};

    columns.forEach((col, idx) => {
      const raw = (cells[idx] ?? "").trim();
      if (col.field) {
        if (raw) row[col.field] = raw;
      } else if (col.header && raw) {
        // Unknown column with a value → preserve under its original header.
        metadata[col.header] = raw;
      }
    });

    if (Object.keys(metadata).length > 0) row.metadata = metadata;
    rows.push(row);
  }

  return { rows, headers, missingEmailColumn };
}
