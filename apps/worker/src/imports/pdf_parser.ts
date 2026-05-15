// PDF table extraction via pdfjs-dist. Strategy:
//   1. Get text items per page with their {x, y, str}.
//   2. Group items by similar Y (line) within each page; sort each line by X.
//   3. Detect repeated column boundaries across the bulk of lines on a page.
//   4. Score the candidate "table region" (length + column consistency).
//   5. Merge cross-page continuations: when two consecutive pages have the
//      same header line, treat the second as a continuation.
//
// Returns one ParsedTable per detected table, ordered by page. We only return
// tables with >=3 rows and >=2 columns to filter noisy paragraphs.

import type { ParsedTable } from "./csv";

interface PdfTextItem { str: string; x: number; y: number; w: number }

interface PdfMod {
  getDocument: (opts: { data: Uint8Array }) => { promise: Promise<PdfDoc> };
}
interface PdfDoc { numPages: number; getPage: (n: number) => Promise<PdfPage> }
interface PdfPage { getTextContent: () => Promise<{ items: unknown[] }> }

let cached: PdfMod | null | undefined;
async function loadPdfjs(): Promise<PdfMod | null> {
  if (cached !== undefined) return cached;
  try {
    const specifier = "pdfjs-dist/legacy/build/pdf.mjs";
    cached = ((await import(/* @vite-ignore */ specifier).catch(() => null)) as PdfMod | null) ?? null;
  } catch { cached = null; }
  return cached;
}

export async function parsePdfTables(bytes: ArrayBuffer): Promise<ParsedTable[]> {
  const mod = await loadPdfjs();
  if (!mod) return [];
  let doc: PdfDoc;
  try { doc = await mod.getDocument({ data: new Uint8Array(bytes) }).promise; }
  catch { return []; }

  const tables: ParsedTable[] = [];
  const pageCount = Math.min(doc.numPages, 100);
  let lastTableHeaderKey: string | null = null;
  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const raw of content.items) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const s = typeof r.str === "string" ? r.str : "";
      if (!s.trim()) continue;
      const tr = Array.isArray(r.transform) ? (r.transform as number[]) : null;
      const x = tr?.[4] ?? 0;
      const y = tr?.[5] ?? 0;
      const w = typeof r.width === "number" ? r.width : 0;
      items.push({ str: s, x, y, w });
    }
    const lines = groupByLine(items);
    const pageTables = detectTables(lines);
    for (const t of pageTables) {
      const headerKey = t.headers.join("|").toLowerCase();
      if (lastTableHeaderKey && headerKey === lastTableHeaderKey && tables.length) {
        // Continuation of previous page's table.
        tables[tables.length - 1].rows.push(...t.rows);
      } else {
        tables.push({ ...t, pageNumber: p });
        lastTableHeaderKey = headerKey;
      }
    }
    if (!pageTables.length) lastTableHeaderKey = null;
  }
  return tables;
}

function groupByLine(items: PdfTextItem[]): PdfTextItem[][] {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];
  const Y_TOL = 2.5;
  for (const it of sorted) {
    let placed = false;
    for (const ln of lines) {
      if (Math.abs(ln[0].y - it.y) <= Y_TOL) { ln.push(it); placed = true; break; }
    }
    if (!placed) lines.push([it]);
  }
  for (const ln of lines) ln.sort((a, b) => a.x - b.x);
  return lines;
}

interface DetectedTable { headers: string[]; rows: Array<Record<string, string>>; confidence: number }

/**
 * Heuristic: walk consecutive lines, infer a column-boundary set from the
 * first plausible "header-ish" line (>=2 items, mostly short text), then
 * group every subsequent line that has items aligning to those columns.
 * Stop the table when a line breaks alignment for >=2 lines in a row.
 */
function detectTables(lines: PdfTextItem[][]): DetectedTable[] {
  const out: DetectedTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i];
    if (headerLine.length < 2) continue;
    const headers = headerLine.map((it) => it.str.trim()).filter(Boolean);
    if (headers.length < 2) continue;
    const cols = headerLine.map((it) => it.x);
    const rows: Array<Record<string, string>> = [];
    let breakStreak = 0;
    let j = i + 1;
    while (j < lines.length) {
      const ln = lines[j];
      const cells = bucketByColumns(ln, cols);
      const filled = cells.filter((c) => c.length).length;
      if (filled >= Math.max(2, Math.ceil(cols.length / 2))) {
        const obj: Record<string, string> = {};
        for (let c = 0; c < headers.length; c++) obj[headers[c] || `col_${c}`] = cells[c]?.join(" ").trim() ?? "";
        rows.push(obj);
        breakStreak = 0;
      } else {
        breakStreak += 1;
        if (breakStreak >= 2) break;
      }
      j += 1;
    }
    if (rows.length >= 3) {
      out.push({ headers, rows, confidence: Math.min(1, rows.length / 20) });
      i = j; // skip past consumed lines
    }
  }
  return out;
}

function bucketByColumns(line: PdfTextItem[], colXs: number[]): string[][] {
  const buckets: string[][] = colXs.map(() => []);
  // Snap each item to the nearest column X.
  for (const it of line) {
    let best = 0;
    let bestDx = Infinity;
    for (let i = 0; i < colXs.length; i++) {
      const dx = Math.abs(it.x - colXs[i]);
      if (dx < bestDx) { bestDx = dx; best = i; }
    }
    buckets[best].push(it.str);
  }
  return buckets;
}
