// Vision-grade PDF/image extractor for image-PDFs (scanned spreadsheet
// exports, photo-of-screen captures, govt-fund flyers).
//
// Workers limitation: there is no DOM CanvasRenderingContext2D, so pdfjs's
// page.render() to an offscreen canvas is unavailable. We use two pathways:
//
//   1. Embedded XObject images: pdfjs `page.getOperatorList()` exposes every
//      Do (paint XObject) operator with a name; `page.objs.get(name)` returns
//      the bitmap (JPEG-encoded for /Filter /DCTDecode, raw RGB otherwise).
//      We pull JPEGs straight through and skip raw RGB (would need PNG
//      encoding which is heavyweight in a Worker).
//   2. Text fallback: when no decodable bitmaps are present (vector-only
//      PDFs, exports from Google Sheets, etc.) we route the per-page pdfjs
//      text through aiExtractTablesFromPdfPages instead of sending the raw
//      PDF container to a vision model (which would just fail).
//
// Output schema matches the AI text fallback in ai/extract.ts so the
// downstream tab-intent / auto-map pipeline is identical.

import type { Env } from "../types";
import type { ParsedTable } from "./csv";
import { aiCacheGet, aiCachePut, sha256Hex } from "../ai/cache";
import { assertBudget } from "../ai/budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";
import { isChromeText } from "./chrome_filter";
import { aiExtractTablesFromPdfPages } from "../ai/extract";

const VISION_MODEL_DEFAULT = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_VISION_PAGES = 10;
/** Vision tab-strip detection: the model returns the labels visible in any
 *  productivity-app sheet-tab strip rendered on the page. We merge these
 *  with pdfjs-text-derived names below — vision wins when both fire. */
const VISION_TAB_STRIP_PROMPT =
  " If a row of sheet tabs is visible at the bottom of the page (Excel/Google Sheets/Numbers), include them as `tab_strip` array of strings, in left-to-right order. Otherwise omit `tab_strip`.";

const VISION_TABLE_SCHEMA = {
  type: "object",
  properties: {
    tables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headers: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        },
        required: ["headers", "rows"],
      },
    },
    // Sheet-tab strip labels detected at the bottom of the page (Excel /
    // Google Sheets / Numbers). Used to recover workbook tab names that
    // pdfjs text extraction can miss for image-only PDFs.
    tab_strip: { type: "array", items: { type: "string" } },
  },
  required: ["tables"],
} as const;

interface PdfMod {
  getDocument: (opts: { data: Uint8Array }) => { promise: Promise<PdfDoc> };
}
interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}
interface PdfPage {
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent?: () => Promise<{ items: Array<{ str: string }> }>;
  objs: { get: (name: string, cb?: (obj: unknown) => void) => unknown };
  commonObjs?: { get: (name: string, cb?: (obj: unknown) => void) => unknown };
}

let cachedMod: PdfMod | null | undefined;
async function loadPdfjs(): Promise<PdfMod | null> {
  if (cachedMod !== undefined) return cachedMod;
  try {
    const specifier = "pdfjs-dist/legacy/build/pdf.mjs";
    cachedMod = ((await import(/* @vite-ignore */ specifier).catch(() => null)) as PdfMod | null) ?? null;
  } catch { cachedMod = null; }
  return cachedMod;
}

interface PageExtraction {
  /** Embedded bitmap (JPEG or PNG) for the page; null when no decodable
   *  image XObject was found. Despite the historical field name, this
   *  may also be a PNG byte array. */
  jpeg: Uint8Array | null;
  /** pdfjs-extracted text on the page (if any), used for OCR-vs-vision
   *  disagreement scoring and tab-strip name detection. */
  pdfText: string;
}

/** Extract embedded JPEG bitmaps + pdfjs text per page. Returns at most one
 *  image per page (the largest), so we don't blow up the AI budget on logo
 *  bitmaps. */
async function extractPages(bytes: ArrayBuffer): Promise<PageExtraction[]> {
  const mod = await loadPdfjs();
  if (!mod) return [];
  let doc: PdfDoc;
  try { doc = await mod.getDocument({ data: new Uint8Array(bytes) }).promise; }
  catch { return []; }
  const out: PageExtraction[] = [];
  const limit = Math.min(doc.numPages, MAX_VISION_PAGES);
  for (let p = 1; p <= limit; p++) {
    const page = await doc.getPage(p);
    let pdfText = "";
    if (typeof page.getTextContent === "function") {
      try {
        const tc = await page.getTextContent();
        pdfText = (tc.items || []).map((it) => String(it.str || "")).join(" ");
      } catch { /* ignore */ }
    }
    let ops: { fnArray: number[]; argsArray: unknown[][] };
    try { ops = await page.getOperatorList(); } catch { continue; }
    let largest: Uint8Array | null = null;
    for (let i = 0; i < ops.fnArray.length; i++) {
      // pdfjs OPS.paintImageXObject = 85, OPS.paintJpegXObject = 82.
      const fn = ops.fnArray[i];
      if (fn !== 82 && fn !== 85) continue;
      const args = ops.argsArray[i];
      const name = Array.isArray(args) && typeof args[0] === "string" ? (args[0] as string) : null;
      if (!name) continue;
      const obj = await new Promise<unknown>((resolve) => {
        try {
          const v = page.objs.get(name, (got) => resolve(got));
          if (v !== undefined) resolve(v);
        } catch { resolve(null); }
      });
      const bm = obj as { data?: Uint8Array | ArrayBuffer; kind?: number; bitmap?: { data?: Uint8Array } } | null;
      if (!bm) continue;
      const data = bm.data instanceof Uint8Array ? bm.data
        : bm.data instanceof ArrayBuffer ? new Uint8Array(bm.data)
        : bm.bitmap?.data instanceof Uint8Array ? bm.bitmap.data
        : null;
      if (!data || data.length < 1024) continue;
      // Accept both JPEG (FF D8) and PNG (89 50 4E 47) bitmaps. macOS
      // Quartz "Print to PDF" of Google Sheets / Excel embeds the
      // rendered grid as a single large PNG XObject, not a JPEG, so
      // restricting to JPEG here was the root cause of "no_table_found"
      // on those exports. Workers AI vision models accept both formats.
      const isJpeg = data[0] === 0xff && data[1] === 0xd8;
      const isPng = data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
      if (!isJpeg && !isPng) continue;
      if (!largest || data.length > largest.length) largest = data;
    }
    out.push({ jpeg: largest, pdfText });
  }
  return out;
}

/** Sniff productivity-app sheet-tab strip names from pdfjs text. Returns the
 *  list of distinct tab names seen at the bottom of any image-PDF page,
 *  ordered by first occurrence. Used to label vision-extracted tables when
 *  the workbook-tab metadata is otherwise lost in raster export. */
export function detectTabStripNames(pageTexts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Heuristic: a tab strip is a run of short labels at the very end of the
  // page text, separated by whitespace, after which only chrome words remain.
  for (const t of pageTexts) {
    const tail = t.slice(-300); // bottom-most ~300 chars of pdfjs text
    // Split into tokens; group adjacent non-chrome short labels.
    const tokens = tail.split(/\s{2,}|\n+/).map((s) => s.trim()).filter(Boolean);
    for (const tok of tokens) {
      if (tok.length < 2 || tok.length > 30) continue;
      if (isChromeText(tok)) continue;
      if (!/^[A-Za-z][\w &/.\-]+$/.test(tok)) continue;
      if (/^(File|Edit|View|Insert|Format|Data|Tools|Add|Help|Share|Comments?)$/i.test(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/** Bounded Levenshtein distance (early-exits when distance exceeds `max`).
 *  Used to compare vision-extracted cells against pdfjs OCR text. */
function levenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (!a.length) return Math.min(b.length, max + 1);
  if (!b.length) return Math.min(a.length, max + 1);
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Per-cell OCR-vs-vision disagreement: for each non-empty vision cell, find
 *  the closest token of similar length in the pdfjs text and compute a
 *  normalized Levenshtein distance. Cells with distance > 0.30 are flagged
 *  for review and persisted in `lowConfidenceCells`. The page-level
 *  disagreement count = number of flagged cells. */
function scoreCellDisagreement(
  visionRows: Array<Record<string, string>>,
  pdfText: string,
  pageNumber: number,
): { score: number; flagged: number; samples: Array<{ row: number; col: string; vision: string; pdf: string; distance: number }>; total: number } {
  const samples: Array<{ row: number; col: string; vision: string; pdf: string; distance: number }> = [];
  if (!visionRows.length || !pdfText) return { score: 0, flagged: 0, samples, total: 0 };
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  // Tokenize pdf text on whitespace; we'll search by length window.
  const tokens = norm(pdfText).split(" ").filter(Boolean);
  let flagged = 0, total = 0;
  for (let r = 0; r < visionRows.length; r++) {
    for (const [col, raw] of Object.entries(visionRows[r])) {
      const v = norm(String(raw));
      if (v.length < 3) continue;
      total += 1;
      // Find nearest pdf token within ±50% length window.
      let bestDist = Infinity, bestTok = "";
      const max = Math.ceil(v.length * 0.6);
      for (const tok of tokens) {
        if (Math.abs(tok.length - v.length) > max) continue;
        const d = levenshtein(v, tok, max);
        if (d < bestDist) { bestDist = d; bestTok = tok; if (d === 0) break; }
      }
      const norm01 = bestDist === Infinity ? 1 : bestDist / Math.max(v.length, 1);
      if (norm01 > 0.30) {
        flagged += 1;
        if (samples.length < 25) {
          samples.push({ row: r, col, vision: String(raw).slice(0, 80), pdf: bestTok.slice(0, 80), distance: Math.round(norm01 * 100) / 100 });
        }
      }
    }
  }
  void pageNumber;
  return {
    score: total ? Math.round((flagged / total) * 100) / 100 : 0,
    flagged, samples, total,
  };
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) {
    s += String.fromCharCode(...b.subarray(i, i + chunk));
  }
  return btoa(s);
}

interface VisionParse {
  tables: Array<{ headers: string[]; rows: string[][] }>;
  tabStrip: string[];
}

function parseTables(res: unknown): VisionParse {
  const r = res as { response?: string; tables?: unknown; tab_strip?: unknown };
  let tables: Array<{ headers: string[]; rows: string[][] }> = [];
  let tabStrip: string[] = [];
  if (Array.isArray(r?.tables)) tables = r.tables as typeof tables;
  if (Array.isArray(r?.tab_strip)) tabStrip = (r.tab_strip as unknown[]).map((s) => String(s)).filter(Boolean);
  if ((!tables.length || !tabStrip.length) && typeof r?.response === "string") {
    try {
      const j = JSON.parse(r.response) as { tables?: typeof tables; tab_strip?: string[] };
      if (!tables.length && Array.isArray(j?.tables)) tables = j.tables!;
      if (!tabStrip.length && Array.isArray(j?.tab_strip)) tabStrip = j.tab_strip!.map(String).filter(Boolean);
    } catch { /* fall through */ }
  }
  return { tables, tabStrip };
}

/** Vision OCR over each extracted page bitmap. Tables are merged across
 *  consecutive pages whose headers match (continuation pattern). When
 *  productivity-app tab-strip names are detected, the n-th distinct tab
 *  name is assigned to the n-th distinct table (by first appearance). */
export async function extractTablesFromImagePdf(env: Env, bytes: ArrayBuffer, opts: { skipOcr?: boolean } = {}): Promise<ParsedTable[]> {
  if (!env.AI) return [];
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return [];
  const pages = await extractPages(bytes);
  // Tab names from pdfjs text first; vision-detected names below take
  // priority when both fire (image-only PDFs have no recoverable text).
  const pdfTabNames = detectTabStripNames(pages.map((p) => p.pdfText));
  const visionTabNames: string[] = [];
  // Keep the original page index alongside each decoded bitmap so that
  // mixed PDFs (some pages with a decodable image XObject, some without)
  // don't drift: `pdfText` and the reported `pageNumber` must always come
  // from the page the bitmap actually belongs to, not the compacted index.
  const images = pages
    .map((p, originalIndex) => (p.jpeg ? { jpeg: p.jpeg, originalIndex } : null))
    .filter((x): x is { jpeg: Uint8Array; originalIndex: number } => x !== null);
  if (!images.length) {
    // No decodable bitmaps. Sending the raw PDF bytes to a vision model is
    // useless (the model expects an image, not a PDF container), so instead
    // fall back to the text-based AI extractor over the per-page pdfjs text
    // we already pulled. Honors skipOcr (cache-only) by short-circuiting.
    if (opts.skipOcr) return [];
    const pageTexts = pages.map((p) => p.pdfText).filter((t) => t.trim().length > 0);
    if (!pageTexts.length) return [];
    return await aiExtractTablesFromPdfPages(env, pageTexts);
  }

  const model = env.AI_VISION_MODEL ?? VISION_MODEL_DEFAULT;
  const out: ParsedTable[] = [];
  let lastHeaderKey: string | null = null;
  let tableIdx = -1;
  for (let p = 0; p < images.length; p++) {
    const bytesPage = images[p].jpeg;
    const origIdx = images[p].originalIndex;
    const pdfText = pages[origIdx]?.pdfText ?? "";
    const cacheKey = await sha256Hex(`${model}:vision-tables-v2:${bytesPage.length}:` + (await sha256Hex(bytesToBase64(bytesPage))));
    let parsed: VisionParse | null = await aiCacheGet<VisionParse>(env, cacheKey);
    if (parsed) {
      trackAi(env, { purpose: "extraction", model, cacheHit: true });
    } else if (opts.skipOcr) {
      // Cache-only mode: never invoke the vision model. Yields an empty
      // page result, which is fine for re-classify/re-map flows.
      parsed = { tables: [], tabStrip: [] };
    } else {
      if (!(await limitAi(env))) continue;
      const t0 = Date.now();
      try {
        const res = (await env.AI.run(model, {
          image: Array.from(bytesPage),
          prompt: "Extract every tabular row visible on this page. Return strict JSON {tables:[{headers,rows}], tab_strip:[...]} where rows are arrays aligned to headers. Skip page numbers, watermarks, app chrome (toolbars, Share buttons), and prose. If the page has no table, return {tables:[]}." + VISION_TAB_STRIP_PROMPT,
          max_tokens: 2048,
          response_format: { type: "json_schema", json_schema: VISION_TABLE_SCHEMA },
        })) as { response?: string; tables?: Array<{ headers: string[]; rows: string[][] }>; tab_strip?: string[] };
        parsed = parseTables(res);
      } catch {
        parsed = { tables: [], tabStrip: [] };
      }
      trackAi(env, { purpose: "extraction", model, ms: Date.now() - t0, neurons: Math.round(bytesPage.length / 1024) });
      await aiCachePut(env, cacheKey, parsed);
    }
    // Merge vision-detected tab strip (deduped, order preserved).
    for (const n of parsed.tabStrip) if (!visionTabNames.includes(n)) visionTabNames.push(n);
    const pageTables = parsed.tables;
    for (const t of pageTables) {
      if (!Array.isArray(t.headers) || t.headers.length < 2) continue;
      if (!Array.isArray(t.rows) || t.rows.length < 1) continue;
      const headers = t.headers.map((h) => String(h || "").trim());
      const headerKey = headers.join("|").toLowerCase();
      const rows = t.rows.map((r) => {
        const obj: Record<string, string> = {};
        for (let c = 0; c < headers.length; c++) obj[headers[c] || `col_${c}`] = String(r?.[c] ?? "").trim();
        return obj;
      }).filter((r) => Object.values(r).some((v) => v.length > 0));
      if (!rows.length) continue;
      const dis = scoreCellDisagreement(rows, pdfText, origIdx + 1);
      if (lastHeaderKey === headerKey && out.length) {
        const last = out[out.length - 1];
        const baseRow = last.rows.length;
        last.rows.push(...rows);
        last.ocrDisagreements = (last.ocrDisagreements ?? 0) + dis.flagged;
        last.lowConfidenceCells = (last.lowConfidenceCells ?? []).concat(
          dis.samples.map((s) => ({ ...s, row: s.row + baseRow }))
        ).slice(0, 25);
      } else {
        tableIdx++;
        // Vision wins; fall back to pdfjs-text-derived names.
        const sheetName = visionTabNames[tableIdx] ?? pdfTabNames[tableIdx] ?? null;
        out.push({
          headers, rows, pageNumber: origIdx + 1,
          confidence: Math.max(0.3, 0.95 - dis.score),
          sheetName: sheetName ?? undefined,
          ocrDisagreements: dis.flagged,
          lowConfidenceCells: dis.samples,
        });
        lastHeaderKey = headerKey;
      }
    }
  }
  // Persist tab-strip-only tabs (README/SIGNUP-like) as zero-row notes
  // entries so file_import_tabs reflects EVERY workbook tab, not only the
  // ones with extractable tables. parse.ts maps __notes__ → intent='notes'.
  const usedNames = new Set<string>(
    out.map((t) => (t.sheetName ?? "").toLowerCase()).filter(Boolean),
  );
  for (const n of [...visionTabNames, ...pdfTabNames]) {
    const k = n.toLowerCase();
    if (!k || usedNames.has(k)) continue;
    usedNames.add(k);
    out.push({ headers: ["__notes__"], rows: [], sheetName: n, confidence: 0.5 });
  }
  return out;
}

/** @deprecated Kept for reference. Raw-PDF-to-vision is unreliable; the
 *  call site now uses aiExtractTablesFromPdfPages over pdfjs page text. */
// @ts-expect-error retained for reference, intentionally unused
async function wholePdfFallback(env: Env, bytes: ArrayBuffer, opts: { skipOcr?: boolean }): Promise<ParsedTable[]> {
  if (!env.AI) return [];
  const ai = env.AI;
  const u8 = new Uint8Array(bytes);
  const model = env.AI_VISION_MODEL ?? VISION_MODEL_DEFAULT;
  const cacheKey = await sha256Hex(`${model}:vision-tables-pdf:` + (await sha256Hex(bytesToBase64(u8))));
  let parsed: VisionParse | null = await aiCacheGet<VisionParse>(env, cacheKey);
  if (!parsed && opts.skipOcr) return [];
  if (!parsed) {
    if (!(await limitAi(env))) return [];
    try {
      const res = (await ai.run(model, {
        image: Array.from(u8),
        prompt: "Extract every tabular row visible in this PDF as strict JSON {tables:[{headers,rows}]}. Skip page numbers, watermarks, and prose." + VISION_TAB_STRIP_PROMPT,
        max_tokens: 4096,
        response_format: { type: "json_schema", json_schema: VISION_TABLE_SCHEMA },
      })) as { response?: string; tables?: Array<{ headers: string[]; rows: string[][] }>; tab_strip?: string[] };
      parsed = parseTables(res);
    } catch { parsed = { tables: [], tabStrip: [] }; }
    await aiCachePut(env, cacheKey, parsed);
  }
  const out: ParsedTable[] = [];
  let idx = -1;
  for (const t of parsed.tables) {
    if (!Array.isArray(t.headers) || t.headers.length < 2) continue;
    if (!Array.isArray(t.rows) || t.rows.length < 1) continue;
    const headers = t.headers.map((h) => String(h || "").trim());
    const rows = t.rows.map((r) => {
      const obj: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) obj[headers[c] || `col_${c}`] = String(r?.[c] ?? "").trim();
      return obj;
    }).filter((r) => Object.values(r).some((v) => v.length > 0));
    if (!rows.length) continue;
    idx++;
    out.push({ headers, rows, confidence: 0.5, sheetName: parsed.tabStrip[idx] });
  }
  return out;
}

/** Single-image vision OCR (for image uploads — png/jpg). */
export async function extractTablesFromImage(env: Env, bytes: ArrayBuffer, opts: { skipOcr?: boolean } = {}): Promise<ParsedTable[]> {
  if (!env.AI) return [];
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return [];
  const u8 = new Uint8Array(bytes);
  const model = env.AI_VISION_MODEL ?? VISION_MODEL_DEFAULT;
  const cacheKey = await sha256Hex(`${model}:vision-tables-img:` + (await sha256Hex(bytesToBase64(u8))));
  let pageTables = await aiCacheGet<Array<{ headers: string[]; rows: string[][] }>>(env, cacheKey);
  if (!pageTables && opts.skipOcr) return [];
  if (!pageTables) {
    if (!(await limitAi(env))) return [];
    try {
      const res = (await env.AI.run(model, {
        image: Array.from(u8),
        prompt: "Extract the table on this image as strict JSON {tables:[{headers,rows}]}.",
        max_tokens: 2048,
        response_format: { type: "json_schema", json_schema: VISION_TABLE_SCHEMA },
      })) as { response?: string; tables?: Array<{ headers: string[]; rows: string[][] }> };
      pageTables = parseTables(res).tables;
    } catch { pageTables = []; }
    await aiCachePut(env, cacheKey, pageTables);
  }
  const out: ParsedTable[] = [];
  for (const t of pageTables) {
    if (!Array.isArray(t.headers) || t.headers.length < 2) continue;
    const headers = t.headers.map((h) => String(h || "").trim());
    const rows = (t.rows || []).map((r) => {
      const obj: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) obj[headers[c] || `col_${c}`] = String(r?.[c] ?? "").trim();
      return obj;
    }).filter((r) => Object.values(r).some((v) => v.length > 0));
    if (rows.length) out.push({ headers, rows, confidence: 0.55 });
  }
  return out;
}
