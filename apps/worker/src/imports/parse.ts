// parse_file queue consumer (Task #2 v2).
// Loads the upload from R2, picks a parser, and emits per-tab classifications
// so the dashboard can render multi-tab mapping with intent toggles.
//
// Wire-format invariants (consumed by routes/uploads.ts and dashboard.js):
//   file_imports.format            = csv|tsv|xlsx|xls|ods|pdf-text|pdf-image|image|gsheet
//   file_imports.tab_count         = number of tabs detected
//   file_imports.column_map_json   = primary tab's confirmed map (legacy clients)
//   file_imports.summary_json      = {format, tabs:[{sheet,intent,...}], source_signature}
//   file_imports.source_signature  = sha256 of (filename pattern + tab names + header sets)
//   file_import_tabs               = one row per tab with intent + map + confidence
//   file_imports.status            = 'mapped' (after parse + auto-classify)

import type { Env } from "../types";
import { parseCsv, type ParsedTable } from "./csv";
import { parseSpreadsheet } from "./xlsx_parser";
import { parsePdfTables } from "./pdf_parser";
import { extractTablesFromImage, extractTablesFromImagePdf } from "./vision_pdf";
import { autoMapHeaders, buildSamples, inferEntity } from "./auto_map";
import { extractUrlsFromRows } from "./url_extract";
import { detectFormat, IMAGE_PDF_DENSITY, type UploadFormat } from "./format_detect";
import { fetchGoogleSheet } from "./google_sheets";
import { classifyTab, type TabIntent } from "./tab_intent";
import { sha256Hex } from "../ai/cache";

interface FileImportRow {
  id: string;
  filename: string;
  mime: string | null;
  r2_key: string;
  format: string | null;
}

interface TabResult {
  tabIndex: number;
  sheetName: string | null;
  pageNumber: number | null;
  intent: TabIntent;
  intentConfidence: number;
  intentSubkind: string | null;
  rowCount: number;
  headers: string[];
  columnMap: Record<string, string>;       // header → "entity.field" | "__skip__"
  mapConfidence: Record<string, number>;
}

/** Optional flags forwarded by the queue when re-running a parse. `skipOcr`
 *  forces the vision pass to use cached results only (cache hits) and
 *  return [] on a miss, so we never re-invoke the vision model. */
export interface ParseConfig { skipOcr?: boolean }

export async function processParseFile(env: Env, importId: string, config: ParseConfig = {}): Promise<void> {
  const row = await env.DB
    .prepare("SELECT id, filename, mime, r2_key, format FROM file_imports WHERE id = ?")
    .bind(importId)
    .first<FileImportRow>();
  if (!row) throw new Error(`file_import_not_found:${importId}`);

  await env.DB
    .prepare("UPDATE file_imports SET status = 'parsing', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), importId)
    .run();

  try {
    const obj = await env.UPLOADS.get(row.r2_key);
    if (!obj) throw new Error("upload_object_missing");
    const bytes = await obj.arrayBuffer();
    const ext = extOf(row.filename);
    // Honor the persisted format (set by /api/uploads/url) before falling
    // back to extension/MIME detection.
    const persistedFormat = (row as unknown as { format?: string | null }).format ?? null;
    const format0 = (persistedFormat as UploadFormat | null) || detectFormat({ ext, mime: row.mime });
    let { tables, format } = await parseByFormat(bytes, format0, env, config);
    if (!tables.length || !tables[0].headers.length) throw new Error("no_table_found");

    // Per-tab classification + auto-mapping.
    const tabResults: TabResult[] = [];
    const urlSet = new Set<string>();
    let primaryIdx = 0;
    let primaryRows = -1;
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      // Synthetic tab-strip-only tab (vision/pdfjs detected the sheet name
      // but no table) — persist as notes intent so the UI shows it.
      const isNotesPlaceholder = t.headers.length === 1 && t.headers[0] === "__notes__";
      const cls = isNotesPlaceholder
        ? { intent: "notes" as TabIntent, confidence: 1, subkind: null }
        : classifyTab(t.sheetName ?? null, t.headers);
      const samples = isNotesPlaceholder ? {} : buildSamples(t.headers, t.rows);
      const auto = isNotesPlaceholder
        ? { map: {}, confidence: {} }
        : autoMapHeaders(t.headers, samples);
      const columnMap: Record<string, string> = {};
      for (const [h, m] of Object.entries(auto.map)) {
        columnMap[h] = m ? `${m.entity}.${m.field}` : "__skip__";
      }
      tabResults.push({
        tabIndex: i,
        sheetName: t.sheetName ?? null,
        pageNumber: t.pageNumber ?? null,
        intent: cls.intent,
        intentConfidence: cls.confidence,
        intentSubkind: cls.subkind ?? null,
        rowCount: t.rows.length,
        headers: isNotesPlaceholder ? [] : t.headers,
        columnMap,
        mapConfidence: auto.confidence,
      });
      if (cls.intent === "firms" && t.rows.length > primaryRows) {
        primaryRows = t.rows.length;
        primaryIdx = i;
      }
      for (const u of extractUrlsFromRows(t.rows)) urlSet.add(u);
    }
    const primary = tables[primaryIdx];
    const primaryTab = tabResults[primaryIdx];
    const urls = Array.from(urlSet);

    // Source signature: filename without trailing digits/timestamp + tab name
    // set + headers per tab, sha256'd. Lets us auto-apply a saved template
    // on a re-upload with the same shape.
    const signature = await computeSourceSignature(row.filename, tabResults);

    // Auto-apply template if one exists for this signature.
    let appliedTemplate: { id: string; name: string } | null = null;
    try {
      const tpl = await env.DB
        .prepare("SELECT id, name, tabs_json FROM import_templates WHERE source_signature = ? ORDER BY use_count DESC LIMIT 1")
        .bind(signature).first<{ id: string; name: string; tabs_json: string }>();
      if (tpl) {
        const overlay = JSON.parse(tpl.tabs_json) as Array<{ sheet?: string; intent?: TabIntent; intent_subkind?: string; column_map?: Record<string, string> }>;
        for (const t of tabResults) {
          const match = overlay.find((o) => (o.sheet ?? "").toLowerCase() === (t.sheetName ?? "").toLowerCase());
          if (!match) continue;
          if (match.intent) { t.intent = match.intent; t.intentConfidence = 1; }
          if (match.intent_subkind) t.intentSubkind = match.intent_subkind;
          if (match.column_map) {
            for (const [h, v] of Object.entries(match.column_map)) {
              if (h in t.columnMap) {
                t.columnMap[h] = v;
                t.mapConfidence[h] = 1;
              }
            }
          }
        }
        appliedTemplate = { id: tpl.id, name: tpl.name };
        await env.DB.prepare(
          "UPDATE import_templates SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
        ).bind(new Date().toISOString(), tpl.id).run();
      }
    } catch { /* template lookup is best-effort */ }

    // Persist per-tab rows.
    await env.DB.prepare("DELETE FROM file_import_tabs WHERE import_id = ?").bind(importId).run();
    for (const t of tabResults) {
      await env.DB.prepare(
        `INSERT INTO file_import_tabs
          (id, import_id, tab_index, sheet_name, page_number, intent, intent_subkind,
           intent_confidence, row_count, column_map_json, map_confidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), importId, t.tabIndex, t.sheetName, t.pageNumber,
        t.intent, t.intentSubkind, t.intentConfidence, t.rowCount,
        JSON.stringify(t.columnMap), JSON.stringify(t.mapConfidence),
        new Date().toISOString(),
      ).run();
    }

    // 10-row preview for the primary tab (v2 spec). Legacy dashboards that
    // only expect 5 rows still work since they slice their own range.
    await env.SCRAPE_CACHE.put(`upload_preview:${importId}`, JSON.stringify({
      headers: primary.headers,
      rows: primary.rows.slice(0, 10),
      tables_found: tables.length,
    }), { expirationTtl: 60 * 60 * 24 * 7 });
    // Per-tab previews (10 rows) so the v2 UI can flip pills without
    // re-fetching and apply bad-cell highlighting on real data.
    const tabPreviews: Record<string, { headers: string[]; rows: Array<Record<string, string>> }> = {};
    for (let i = 0; i < tables.length; i++) {
      tabPreviews[String(i)] = { headers: tables[i].headers, rows: tables[i].rows.slice(0, 10) };
    }
    await env.SCRAPE_CACHE.put(`upload_tab_previews:${importId}`, JSON.stringify(tabPreviews), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
    // Persist FULL per-tab rows so /diff-preview (and any future dry-run
    // tooling) can run against the parsed data without re-parsing.
    const tabRows: Record<string, Array<Record<string, string>>> = {};
    for (let i = 0; i < tables.length; i++) tabRows[String(i)] = tables[i].rows;
    await env.SCRAPE_CACHE.put(`upload_rows:${importId}`, JSON.stringify(tabRows), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
    await env.SCRAPE_CACHE.put(`upload_urls:${importId}`, JSON.stringify(urls), {
      expirationTtl: 60 * 60 * 24 * 7,
    });

    // Pre-confirmation entity from the dominant tab's intent.
    const entity = primaryTab.intent === "firms" ? "firms" : (inferEntity(toMappedFieldRecord(primaryTab.columnMap)));

    // Acceptance-schema summary: per-tab `rows_seen / rows_imported /
    // rows_updated / rows_rejected / low_confidence_cells /
    // ocr_disagreements`, plus aggregate keys at the top level. The
    // *_imported / *_updated / *_rejected counters land at confirm-map
    // time (import.ts) — here at parse time we seed the rest.
    const lowConfThreshold = 0.65;
    const summaryTabs = tabResults.map((t, i) => {
      const src = tables[i] ?? { lowConfidenceCells: [], ocrDisagreements: 0 };
      const lowConfCells = Object.values(t.mapConfidence).filter((c) => c < lowConfThreshold).length;
      return {
        index: t.tabIndex,
        sheet: t.sheetName,
        page: t.pageNumber,
        intent: t.intent,
        intent_subkind: t.intentSubkind,
        intent_confidence: t.intentConfidence,
        rows_seen: t.rowCount,
        rows_imported: 0,
        rows_updated: 0,
        rows_rejected: 0,
        low_confidence_cells: lowConfCells,
        ocr_disagreements: src.ocrDisagreements ?? 0,
        ocr_disagreement_samples: (src.lowConfidenceCells ?? []).slice(0, 10),
        avg_map_confidence: avg(Object.values(t.mapConfidence)),
      };
    });
    const summary = {
      format,
      tab_count: tables.length,
      rows_seen_total: summaryTabs.reduce((s, t) => s + t.rows_seen, 0),
      rows_imported_total: 0,
      rows_updated_total: 0,
      rows_rejected_total: 0,
      low_confidence_cells_total: summaryTabs.reduce((s, t) => s + t.low_confidence_cells, 0),
      ocr_disagreements_total: summaryTabs.reduce((s, t) => s + t.ocr_disagreements, 0),
      tabs: summaryTabs,
      source_signature: signature,
      template_applied: appliedTemplate,
    };

    await env.DB.prepare(
      `UPDATE file_imports
         SET status = 'mapped',
             format = ?,
             entity = ?,
             row_count = ?,
             tab_count = ?,
             urls_found = ?,
             column_map_json = ?,
             summary_json = ?,
             source_signature = ?,
             updated_at = ?
       WHERE id = ?`,
    ).bind(
      format,
      entity === "firm_metrics" ? "firms" : entity,
      primary.rows.length,
      tables.length,
      urls.length,
      JSON.stringify(primaryTab.columnMap),
      JSON.stringify(summary),
      signature,
      new Date().toISOString(),
      importId,
    ).run();
  } catch (e) {
    await env.DB.prepare(
      "UPDATE file_imports SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
    ).bind(String((e as Error).message).slice(0, 500), new Date().toISOString(), importId).run();
    throw e;
  }
}

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : "";
}

function avg(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0; for (const x of xs) s += x;
  return Math.round((s / xs.length) * 100) / 100;
}

function toMappedFieldRecord(m: Record<string, string>): Record<string, { entity: "firms" | "leads" | "firm_metrics"; field: string } | null> {
  const out: Record<string, { entity: "firms" | "leads" | "firm_metrics"; field: string } | null> = {};
  for (const [h, v] of Object.entries(m)) {
    if (!v || v === "__skip__") { out[h] = null; continue; }
    const dot = v.indexOf(".");
    if (dot < 0) { out[h] = null; continue; }
    out[h] = { entity: v.slice(0, dot) as "firms" | "leads" | "firm_metrics", field: v.slice(dot + 1) };
  }
  return out;
}

async function computeSourceSignature(filename: string, tabs: TabResult[]): Promise<string> {
  const filePattern = filename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[\d_-]+(20\d{2}|19\d{2})?$/i, "")
    .replace(/[\W_]+/g, " ")
    .trim()
    .toLowerCase();
  const sig = JSON.stringify({
    f: filePattern,
    tabs: tabs.map((t) => ({
      n: (t.sheetName ?? "").toLowerCase(),
      h: t.headers.map((h) => h.toLowerCase().trim()).sort(),
    })).sort((a, b) => a.n.localeCompare(b.n)),
  });
  return sha256Hex(sig);
}

async function parseByFormat(
  bytes: ArrayBuffer,
  format0: UploadFormat,
  env: Env,
  config: ParseConfig = {},
): Promise<{ tables: ParsedTable[]; format: UploadFormat }> {
  // URL uploads (Google Sheets / Airtable) are stored as a JSON blob
  // {source_url, format, tables} by routes/uploads.ts → /url. The blob is
  // saved with a `.csv` filename for backward-compat, so extension-based
  // detection can mislabel it. Sniff the body magic FIRST so the JSON
  // envelope wins regardless of declared format.
  const decoded = decodeJsonBlob(bytes);
  if (decoded) return { tables: decoded.tables, format: (decoded.format as UploadFormat) || (format0 === "csv" ? "gsheet" : format0) };
  if (format0 === "csv")  return { tables: [parseCsv(new TextDecoder().decode(bytes))], format: "csv" };
  if (format0 === "tsv")  return { tables: [parseCsv(new TextDecoder().decode(bytes), "\t")], format: "tsv" };
  if (format0 === "xlsx" || format0 === "xls" || format0 === "ods") {
    return { tables: await parseSpreadsheet(bytes), format: format0 };
  }
  if (format0 === "pdf-text") {
    const tables = await parsePdfTables(bytes, env);
    // Density check: low char-density per detected row → image PDF; try
    // vision extractor if available.
    const totalChars = tables.reduce((acc, t) => acc + t.rows.reduce((a, r) => a + Object.values(r).join("").length, 0), 0);
    const totalRows = tables.reduce((acc, t) => acc + t.rows.length, 0);
    const density = totalRows > 0 ? totalChars / Math.max(1, totalRows) : 0;
    if ((!tables.length || density < IMAGE_PDF_DENSITY) && env.AI) {
      const v = await extractTablesFromImagePdf(env, bytes, { skipOcr: config.skipOcr === true });
      if (v.length) return { tables: v, format: "pdf-image" };
    }
    return { tables, format: tables.length ? "pdf-text" : "pdf-image" };
  }
  if (format0 === "image") {
    const v = await extractTablesFromImage(env, bytes, { skipOcr: config.skipOcr === true });
    return { tables: v, format: "image" };
  }
  // Default: try spreadsheet (sheetjs sniffs CSV too).
  return { tables: await parseSpreadsheet(bytes), format: format0 };
}

/** Decode the JSON blob written by routes/uploads.ts /url. Returns null if
 *  not a valid envelope. */
function decodeJsonBlob(bytes: ArrayBuffer): { format?: string; tables: ParsedTable[] } | null {
  // Cheap sniff: starts with '{' after BOM/whitespace.
  if (bytes.byteLength < 2) return null;
  const u8 = new Uint8Array(bytes);
  let i = 0; while (i < u8.length && (u8[i] === 0xef || u8[i] === 0xbb || u8[i] === 0xbf || u8[i] <= 0x20)) i++;
  if (u8[i] !== 0x7b) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as { format?: string; tables?: ParsedTable[] };
    if (Array.isArray(j?.tables)) return { format: j.format, tables: j.tables };
    return null;
  } catch { return null; }
}

/** Public URL entrypoint used by routes/uploads.ts when a URL is uploaded
 *  instead of a file. Supports Google Sheets natively; for Airtable shared
 *  views we follow the standard `?download=csv` export. Other URLs are
 *  fetched and probed for HTML <table> markup. */
export async function fetchAndParseUrl(url: string): Promise<{ tables: ParsedTable[]; format: UploadFormat }> {
  const fmt = detectFormat({ url });
  if (fmt === "gsheet") return { tables: await fetchGoogleSheet(url), format: "gsheet" };
  if (fmt === "airtable") {
    // Airtable public-share views expose a CSV download at the same path.
    const csvUrl = url.includes("?") ? `${url}&download=csv` : `${url}?download=csv`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15_000);
    try {
      const r = await fetch(csvUrl, { signal: ac.signal, headers: { accept: "text/csv,*/*" } });
      if (!r.ok) return { tables: [], format: "airtable" };
      const txt = await r.text();
      const tab = parseCsv(txt);
      tab.sheetName = tab.sheetName ?? "Airtable";
      return { tables: [tab], format: "airtable" };
    } catch { return { tables: [], format: "airtable" }; }
    finally { clearTimeout(t); }
  }
  // Generic HTML — fetch and try sheetjs HTML table parser if installed.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) return { tables: [], format: fmt };
    const bytes = await r.arrayBuffer();
    return { tables: await parseSpreadsheet(bytes), format: "html" };
  } catch { return { tables: [], format: fmt }; }
  finally { clearTimeout(t); }
}
