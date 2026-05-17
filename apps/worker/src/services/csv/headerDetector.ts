// Task #5: CSV header detection + type-string safeguard.
//
// The operator's `VC_PE - List of investors….csv` ships with NO header
// row — row 0 is data ("500 LGBT Syndicate,VC,…"). The legacy CSV
// importers (src/imports/csv_import.ts streaming path and
// src/imports/import.ts via parseCsv) unconditionally treat row 0 as
// headers, then the auto-mapper picks the type-string column ("VC",
// "Nonprofit, Training Program", …) as `firm.name` because the real
// firm-name cell now lives one column off.
//
// This module exposes two pure, side-effect-free helpers used by both
// CSV import paths:
//
//   * detectHasHeader(rows)   — heuristic decision (≤10 rows looked at)
//   * looksLikeTypeString(s)  — pre-insert safeguard regex
//
// The regex is the source of truth for both the safeguard AND the
// backfill migration; keep them in sync. New type-string values found
// in operator uploads should be added here AND in the SQL `LIKE` /
// regex set in migrations/333_backfill_corrupted_names.sql.

/** Single source of truth for the "this is a Type/Kind cell, not a
 *  firm name" pattern. Matches a bare keyword OR a keyword followed by
 *  ", <anything>" so "VC, Fellows Program" and "Nonprofit, Training
 *  Program" are both caught. */
export const TYPE_STRING_REGEX =
  /^(VC|PE|Angel|Accelerator|Incubator|Nonprofit|Bootcamp|Network|Platform|Micro VC|Corporate VC|Fellows? Program|Training Program|Pitch Competition|Equity Crowdfunding|Mentorship|Impact Investing|Venture Development|VC Fellows Program)(,\s*.+)?$/i;

/** True when `value` looks like a Type/Kind cell rather than a firm
 *  name. Trims and short-circuits on empty input. */
export function looksLikeTypeString(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = String(value).trim();
  if (!v) return false;
  return TYPE_STRING_REGEX.test(v);
}

/** Cells that look like header labels: short (≤40 chars), no URLs, no
 *  currency markers, no embedded commas (commas inside a quoted CSV
 *  cell typically signal data like "Early Stage, Seed"). */
function looksLikeHeaderLabel(cell: string): boolean {
  const v = (cell ?? "").trim();
  if (!v) return false; // empty cells are common in data rows AND label rows; neutral
  if (v.length > 40) return false;
  if (/^https?:\/\//i.test(v)) return false;
  if (/\.(com|org|io|co|net|ai|app|dev|gov|edu)\b/i.test(v)) return false;
  if (/[$€£¥]/.test(v)) return false;
  if (/^\$?\d/.test(v)) return false;          // starts with money/number
  if (/\b\d+(?:[.,]\d+)?\s*[kmbKMB]\b/.test(v)) return false; // 1.5M, 500K
  if (/,/.test(v)) return false;               // commas inside cells → data
  return true;
}

/** Per-column heterogeneity check: across the sample rows, the column
 *  shows a mix of types (string vs URL vs money vs ISO2 vs numeric).
 *  Header rows look uniform (all labels); data rows are heterogeneous. */
function isColumnHeterogeneous(values: string[]): boolean {
  const kinds = new Set<string>();
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    if (/^https?:\/\//i.test(v) || /\.(com|org|io|co|net|ai|app|dev)\b/i.test(v)) kinds.add("url");
    else if (/[$€£¥]/.test(v) || /\b\d+(?:[.,]\d+)?\s*[kmbKMB]\b/.test(v)) kinds.add("money");
    else if (/^\d+$/.test(v)) kinds.add("int");
    else if (/^[A-Z]{2}$/.test(v)) kinds.add("iso2");
    else kinds.add("text");
  }
  return kinds.size >= 2;
}

/**
 * Decide whether row 0 of a CSV is a header row.
 *
 * Returns true iff:
 *   1. Every non-empty row-0 cell looks like a header label
 *      (short, no URLs / currencies / embedded commas), AND
 *   2. At least one column across rows 1..N is heterogeneous
 *      (data rows look different from labels).
 *
 * Defaults to `true` when the sample is too small to decide (1 row
 * total) — preserves legacy "row 0 = headers" behaviour for trivial
 * inputs. Defaults to `false` (no header) when row 0 itself contains
 * obvious data markers like URLs or currencies.
 */
export function detectHasHeader(rows: string[][]): boolean {
  if (!rows.length) return false;
  const row0 = rows[0] ?? [];
  if (!row0.length) return false;
  // Strong negative: row 0 has any data-shaped cell → not a header.
  const nonEmpty0 = row0.filter((c) => (c ?? "").trim().length > 0);
  if (!nonEmpty0.length) return false;
  for (const c of nonEmpty0) {
    if (!looksLikeHeaderLabel(c)) return false;
  }
  // Single-row file: trust the label-shape signal alone.
  if (rows.length < 2) return true;
  // Confirm with heterogeneity: at least one column across rows 1..N
  // shows a mix of value kinds. Pure-text data also passes if row 0's
  // cells all look like clean labels — guarded by requiring at least
  // one cell with a data marker (URL/money/ISO2/digit-string).
  const dataRows = rows.slice(1);
  for (let c = 0; c < row0.length; c++) {
    const col = dataRows.map((r) => r[c] ?? "");
    if (isColumnHeterogeneous(col)) return true;
  }
  // Fallback: any single data cell anywhere with a data marker is
  // enough to conclude rows 1..N are data, not more labels.
  for (const r of dataRows) {
    for (const v of r) {
      const t = (v ?? "").trim();
      if (!t) continue;
      if (/^https?:\/\//i.test(t)) return true;
      if (/[$€£¥]/.test(t)) return true;
      if (/\b\d+(?:[.,]\d+)?\s*[kmbKMB]\b/.test(t)) return true;
      if (/^[A-Z]{2}$/.test(t)) return true;
    }
  }
  // Strict spec rule: header iff label-shape AND heterogeneity (or a
  // data-marker in rows 1..N). If we reach here, rows 1..N look as
  // uniform as row 0 → safer to assume the file is headerless and
  // synthesize col_0..col_N. (Operator can re-upload with a real
  // header if synthesis is wrong; the prior behaviour silently
  // promoted the first data row into firm.name.)
  return false;
}

/** Build synthetic header names for a headerless CSV: col_0..col_N. */
export function synthesizeHeaders(columnCount: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < columnCount; i++) out.push(`col_${i}`);
  return out;
}
