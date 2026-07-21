// ---------------------------------------------------------------------------
// Delimited-text parser for the creator-import flow (PLU-109)
// ---------------------------------------------------------------------------
// Moved from web/src/lib/parseCsv.ts: the SERVER is now the single source of
// truth for parsing, so the preview the operator confirms is produced by the
// exact same parse that will later run the import. The client no longer parses
// at all, so there is no second implementation to keep in sync.
//
// Hand-rolled to avoid a dependency. Handles the features a real-world contact
// or creator-discovery export actually uses:
//   - quoted fields:            "Doe, Jane"
//   - escaped quotes in quotes: "She said ""hi"""
//   - newlines inside quotes:   "line1\nline2"
//   - CRLF or LF line endings
//   - a BOM at the start of the file
//   - TAB, comma, or semicolon delimiters (sniffed — see pickDelimiter)
//
// This module is deliberately field-agnostic: it returns the raw header list
// plus one record per row keyed by ORIGINAL header. Mapping those headers onto
// creator fields (aliases, per-network derivation) is creatorFields.ts's job.

/** Delimiters we will sniff for, in tie-break preference order. */
const CANDIDATE_DELIMITERS = ["\t", ",", ";"] as const;
export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number];

export interface ParseDelimitedResult {
  /** Original header names, in file order (for diagnostics / preview). */
  headers: string[];
  /** One record per data row, keyed by original header. */
  records: Array<Record<string, string>>;
  /** The delimiter actually used, for the preview to report. */
  delimiter: Delimiter;
  /** Total data rows (excludes the header and blank lines). */
  rowCount: number;
}

/**
 * Choose the delimiter by counting candidates in the header line.
 *
 * Vendor creator-discovery exports are frequently TAB-separated despite the
 * ".csv" extension. The previous parser hardcoded "," and would read such a
 * file as ONE column — then reject it for having no email column. Sniffing on
 * the header line is reliable here because the header is the one row
 * guaranteed to contain a delimiter between every field.
 *
 * Counting is done on the raw header line rather than post-tokenization: a
 * quoted header containing a stray comma could skew the count, but only if it
 * out-counts the real delimiter, which needs more commas inside one header cell
 * than there are columns. Not worth the complexity to defend against.
 */
export function pickDelimiter(text: string): Delimiter {
  const firstBreak = text.indexOf("\n");
  const headerLine = (firstBreak === -1 ? text : text.slice(0, firstBreak)).replace(/\r$/, "");

  let best: Delimiter = ",";
  let bestCount = 0;
  for (const d of CANDIDATE_DELIMITERS) {
    let count = 0;
    for (const ch of headerLine) if (ch === d) count++;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  // No delimiter at all → a single-column file; comma is the harmless default.
  return best;
}

/**
 * Tokenize delimited text into a matrix of string cells. RFC-4180-ish: quotes
 * wrap fields, "" is a literal quote, delimiters/newlines inside quotes are
 * literal.
 */
export function tokenize(text: string, delimiter: Delimiter): string[][] {
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
    if (ch === delimiter) {
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
 * Parse delimited text into headers + per-row records keyed by original header.
 * Blank lines are skipped and every cell is trimmed. Empty cells are omitted
 * from the record entirely, so downstream `??` fallbacks behave.
 *
 * Duplicate headers: the LAST non-empty cell wins, since a record is keyed by
 * header name. Vendor exports do not duplicate headers in practice; this just
 * makes the behaviour defined rather than accidental.
 */
export function parseDelimited(text: string): ParseDelimitedResult {
  const delimiter = pickDelimiter(text);
  const matrix = tokenize(text, delimiter).filter((r) => !isBlankRow(r));

  if (matrix.length === 0) {
    return { headers: [], records: [], delimiter, rowCount: 0 };
  }

  const headers = matrix[0]!.map((h) => h.trim());

  const records: Array<Record<string, string>> = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r]!;
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      const raw = (cells[idx] ?? "").trim();
      if (raw) record[header] = raw;
    });
    records.push(record);
  }

  return { headers, records, delimiter, rowCount: records.length };
}
