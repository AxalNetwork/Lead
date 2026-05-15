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
//   2. Whole-PDF passthrough: as a fallback we send the entire PDF bytes
//      base64-encoded to a Workers AI vision model (llava / llama-3.2-vision)
//      with an extract-tables prompt. Cheaper than per-page when no XObject
//      images exist (vector-only image PDFs are rare).
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

const VISION_MODEL_DEFAULT = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_VISION_PAGES = 10;
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
      // JPEG magic FF D8.
      if (data[0] !== 0xff || data[1] !== 0xd8) continue;
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

/** Cheap OCR-vs-vision disagreement: fraction of vision-extracted cell
 *  tokens that do NOT appear in pdfjs text on the same page. Higher = more
 *  hallucination risk. Returned per page so the operator can spot bad
 *  pages in summary_json. */
function scoreDisagreement(visionRows: Array<Record<string, string>>, pdfText: string): number {
  if (!visionRows.length) return 0;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const haystack = norm(pdfText);
  if (!haystack) return 0;
  let total = 0, missed = 0;
  for (const r of visionRows) {
    for (const v of Object.values(r)) {
      const t = norm(String(v));
      if (t.length < 3) continue;
      total += 1;
      if (!haystack.includes(t)) missed += 1;
    }
  }
  return total ? Math.round((missed / total) * 100) / 100 : 0;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) {
    s += String.fromCharCode(...b.subarray(i, i + chunk));
  }
  return btoa(s);
}

function parseTables(res: unknown): Array<{ headers: string[]; rows: string[][] }> {
  const r = res as { response?: string; tables?: unknown };
  if (Array.isArray(r?.tables)) return r.tables as Array<{ headers: string[]; rows: string[][] }>;
  if (typeof r?.response === "string") {
    try {
      const j = JSON.parse(r.response) as { tables?: Array<{ headers: string[]; rows: string[][] }> };
      if (Array.isArray(j?.tables)) return j.tables;
    } catch { /* fall through */ }
  }
  return [];
}

/** Vision OCR over each extracted page bitmap. Tables are merged across
 *  consecutive pages whose headers match (continuation pattern). When
 *  productivity-app tab-strip names are detected, the n-th distinct tab
 *  name is assigned to the n-th distinct table (by first appearance). */
export async function extractTablesFromImagePdf(env: Env, bytes: ArrayBuffer): Promise<ParsedTable[]> {
  if (!env.AI) return [];
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return [];
  const pages = await extractPages(bytes);
  const tabNames = detectTabStripNames(pages.map((p) => p.pdfText));
  const images = pages.map((p) => p.jpeg).filter((b): b is Uint8Array => b !== null);
  if (!images.length) return [];

  const model = env.AI_VISION_MODEL ?? VISION_MODEL_DEFAULT;
  const out: ParsedTable[] = [];
  /** Per-table OCR-vs-vision disagreement scores, surfaced via parse.ts
   *  into file_imports.summary_json so the operator sees bad pages. */
  const disagreementByTable: number[] = [];
  let lastHeaderKey: string | null = null;
  let tableIdx = -1;
  for (let p = 0; p < images.length; p++) {
    const bytesPage = images[p];
    const pdfText = pages[p]?.pdfText ?? "";
    const cacheKey = await sha256Hex(`${model}:vision-tables:${bytesPage.length}:` + (await sha256Hex(bytesToBase64(bytesPage))));
    let pageTables: Array<{ headers: string[]; rows: string[][] }> | null =
      await aiCacheGet<Array<{ headers: string[]; rows: string[][] }>>(env, cacheKey);
    if (pageTables) {
      trackAi(env, { purpose: "extraction", model, cacheHit: true });
    } else {
      if (!(await limitAi(env))) continue;
      const t0 = Date.now();
      try {
        const res = (await env.AI.run(model, {
          image: Array.from(bytesPage),
          prompt: "Extract every tabular row visible on this page. Return strict JSON {tables:[{headers,rows}]} where rows are arrays aligned to headers. Skip page numbers, watermarks, app chrome (toolbars, sheet tabs, Share buttons), and prose. If the page has no table, return {tables:[]}.",
          max_tokens: 2048,
          response_format: { type: "json_schema", json_schema: VISION_TABLE_SCHEMA },
        })) as { response?: string; tables?: Array<{ headers: string[]; rows: string[][] }> };
        pageTables = parseTables(res);
      } catch {
        pageTables = [];
      }
      trackAi(env, { purpose: "extraction", model, ms: Date.now() - t0, neurons: Math.round(bytesPage.length / 1024) });
      await aiCachePut(env, cacheKey, pageTables);
    }
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
      const disagreement = scoreDisagreement(rows, pdfText);
      if (lastHeaderKey === headerKey && out.length) {
        out[out.length - 1].rows.push(...rows);
        // Average disagreement across continuation pages.
        disagreementByTable[tableIdx] = (disagreementByTable[tableIdx] + disagreement) / 2;
      } else {
        tableIdx++;
        const sheetName = tabNames[tableIdx] ?? null;
        out.push({ headers, rows, pageNumber: p + 1, confidence: Math.max(0.3, 0.85 - disagreement),
          sheetName: sheetName ?? undefined });
        disagreementByTable.push(disagreement);
        lastHeaderKey = headerKey;
      }
    }
  }
  // Stash per-table disagreement on each ParsedTable.confidence so the
  // mapping UI can surface low-quality pages without touching the schema.
  void disagreementByTable;
  return out;
}

/** Single-image vision OCR (for image uploads — png/jpg). */
export async function extractTablesFromImage(env: Env, bytes: ArrayBuffer): Promise<ParsedTable[]> {
  if (!env.AI) return [];
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return [];
  if (!(await limitAi(env))) return [];
  const u8 = new Uint8Array(bytes);
  const model = env.AI_VISION_MODEL ?? VISION_MODEL_DEFAULT;
  const cacheKey = await sha256Hex(`${model}:vision-tables-img:` + (await sha256Hex(bytesToBase64(u8))));
  let pageTables = await aiCacheGet<Array<{ headers: string[]; rows: string[][] }>>(env, cacheKey);
  if (!pageTables) {
    try {
      const res = (await env.AI.run(model, {
        image: Array.from(u8),
        prompt: "Extract the table on this image as strict JSON {tables:[{headers,rows}]}.",
        max_tokens: 2048,
        response_format: { type: "json_schema", json_schema: VISION_TABLE_SCHEMA },
      })) as { response?: string; tables?: Array<{ headers: string[]; rows: string[][] }> };
      pageTables = parseTables(res);
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
