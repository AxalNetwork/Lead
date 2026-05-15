// RFC4180-ish CSV/TSV parser with delimiter sniffing. No external deps.
// Returns a uniform { headers, rows } shape; rows are arrays aligned to headers.

export interface ParsedTable {
  headers: string[];
  rows: Array<Record<string, string>>;
  /** Optional debug info; not all parsers populate. */
  pageNumber?: number;
  confidence?: number;
  /** XLSX/ODS sheet name; Google Sheets tab name. */
  sheetName?: string;
  /** Per-cell OCR-vs-vision disagreement count (>30% Levenshtein). Only
   *  populated by vision_pdf for image-PDF tabs. */
  ocrDisagreements?: number;
  /** Cells whose vision-extracted value disagrees materially with the
   *  pdfjs text on the same page. Each entry is {row, col, vision, pdf,
   *  distance}. */
  lowConfidenceCells?: Array<{ row: number; col: string; vision: string; pdf: string; distance: number }>;
}

const DELIMS = [",", "\t", ";", "|"];

export function sniffDelimiter(sample: string): string {
  // Score each delimiter by how consistent the per-line column count is in
  // the first ~10 non-empty lines. The most-consistent (and >1 column)
  // delimiter wins; comma is the tie-breaker.
  const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ",";
  let bestScore = -1;
  for (const d of DELIMS) {
    const counts = lines.map((l) => splitCsvLine(l, d).length);
    if (!counts.length) continue;
    const max = Math.max(...counts);
    if (max < 2) continue;
    const consistent = counts.filter((c) => c === max).length;
    const score = consistent * 10 + max;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** RFC4180 line splitter that respects "quoted" fields with "" escapes. */
function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a CSV/TSV blob. Handles quoted fields containing newlines via a
 * record accumulator (we feed character-at-a-time tracking the in-quote
 * flag across line boundaries, so a record may span multiple raw lines).
 */
export function parseCsv(text: string, delimHint?: string): ParsedTable {
  const delim = delimHint || sniffDelimiter(text.slice(0, 4096));
  const records: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === delim) { row.push(cur); cur = ""; }
      else if (ch === "\r") { /* skip */ }
      else if (ch === "\n") { row.push(cur); records.push(row); row = []; cur = ""; }
      else cur += ch;
    }
  }
  if (cur.length || row.length) { row.push(cur); records.push(row); }
  // Drop trailing empty rows (common artifact of trailing newline).
  while (records.length && records[records.length - 1].every((c) => c === "")) records.pop();
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r < records.length; r++) {
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = (records[r][c] ?? "").trim();
    rows.push(obj);
  }
  return { headers, rows };
}
