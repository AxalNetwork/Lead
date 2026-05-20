// Task #3: Google Sheets full-workbook importer.
//
// Given any `docs.google.com/spreadsheets/d/{id}` URL we:
//   1. Discover every tab in the workbook (gid → name) by scraping the
//      editor HTML for both `bootstrapData` JSON and the bottom-tab DOM.
//   2. Pull each tab via the public `gviz/tq?tqx=out:json&gid=N` JSONP
//      endpoint, falling back to `/export?format=csv` then `format=tsv`
//      when gviz refuses (private sheet, transient 5xx, etc.).
//   3. Detect README / Instructions / signup tabs and drop them.
//   4. Classify the remaining tabs via the shared `tab_intent` router:
//        - firms / leads        → emit FirmCandidate / PersonCandidate rows
//        - firm_metrics / firm_kpi / firm_geo → emit metric rows joined to
//          firms-tab entries by normalized name
//   5. Surface `sheet_not_public` when every endpoint fails, with a
//      user-facing fix-it tip the dashboard renders verbatim.
//
// gviz cell shape: { v: raw, f: formatted-string-or-undefined }
//   - `v` is the source of truth for numbers / dates.
//   - `f` is preserved for currency strings ("€80M", "$2.5B") so the
//     coercer can recover the original currency code.

import type { Env } from "../../../types";
import type {
  FirmCandidate,
  FirmlistImportResult,
  KeyedFirmCandidate,
  KeyedPersonCandidate,
  PersonCandidate,
} from "./types";
import { rowToCandidate } from "./_helpers";
import { extractTabs } from "../../../imports/google_sheets";
import { classifyTab } from "../../../imports/tab_intent";
import { autoMapHeaders, buildSamples, type MappedField } from "../../../imports/auto_map";
import { parseMoney, parseYear, parseCountryIso2 } from "../../../imports/coercers";
import { aiArbitrate } from "../../../ai/extract";

const UA = "Mozilla/5.0 AIDataSignalBot/1.0";
const README_RE = /\b(read\s*me|readme|instructions?|how\s*to|getting\s*started|sign[\s_-]*up|signup|first\s*tab|welcome|cover\s*page?|disclaimer|tos|terms)\b/i;

/** Same shape as a metric in `FirmlistImportResult["metrics"]`, but the
 *  firm key isn't known yet — we capture the raw + normalized firm
 *  name so the async arbitration pass can resolve it later. */
interface PendingMetric {
  rawName: string;
  norm: string;
  metric_name: string;
  metric_date: string;
  dimension?: string | null;
  value_num?: number | null;
  value_text?: string | null;
  source_url?: string | null;
}

export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const ids = parseSheetUrl(url);
  if (!ids) return { firms: [], totalSeen: 0, errors: ["unrecognized_sheet_url"] };
  const { sheetId } = ids;

  // ---- Tab discovery ----------------------------------------------------
  const editorHtml = await fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  let tabs: Array<{ gid: string; name: string }> = [];
  if (editorHtml) tabs = extractTabs(editorHtml);
  if (!tabs.length) {
    // Last-ditch: try fetching the default tab anyway. If THAT also 4xxs
    // the sheet really isn't public and we surface a fix-it error.
    const probe = await fetchTabRows(sheetId, "0");
    if (!probe) {
      return {
        firms: [],
        totalSeen: 0,
        errors: [
          "sheet_not_public",
          "fix:Set the sheet's share setting to 'Anyone with the link can view' and retry.",
        ],
      };
    }
    tabs = [{ gid: "0", name: "Sheet1" }];
  }

  const firms: KeyedFirmCandidate[] = [];
  const people: KeyedPersonCandidate[] = [];
  const metrics: NonNullable<FirmlistImportResult["metrics"]> = [];
  const importNotes: NonNullable<FirmlistImportResult["importNotes"]> = [];
  const errors: string[] = [];
  const tableTabs: NonNullable<FirmlistImportResult["tableTabs"]> = [];
  let totalSeen = 0;

  // Map normalized firm name → import_key so metrics tabs can join.
  const nameKeyByNorm = new Map<string, string>();
  const seenFirmKeys = new Set<string>();
  const seenPersonKeys = new Set<string>();

  // ---- Pass 1: fetch + classify every tab. We DON'T extract metrics
  // yet because `nameKeyByNorm` may not be fully populated until every
  // firms-intent tab has been processed. Tab discovery order is not
  // guaranteed by the HTML-scrape, so a metrics tab that happens to
  // precede the firms tab would otherwise drop every metric.
  interface PreppedTab {
    gid: string;
    name: string;
    intent: import("../../../imports/tab_intent").TabIntent;
    subkind?: string;
    headers: string[];
    rows: ParsedTabRows["rows"];
  }
  const prepped: PreppedTab[] = [];
  let tabsFetched = 0;
  for (let tabIdx = 0; tabIdx < tabs.length; tabIdx++) {
    const tab = tabs[tabIdx];
    const parsed = await fetchTabRows(sheetId, tab.gid);
    if (!parsed) {
      errors.push(`tab_fetch_fail:${tab.name}`);
      tableTabs.push({ tableId: tab.gid, name: tab.name, intent: "error", rowCount: 0 });
      continue;
    }
    tabsFetched += 1;
    const { headers, rows } = parsed;
    if (!headers.length) {
      tableTabs.push({ tableId: tab.gid, name: tab.name, intent: "empty", rowCount: 0 });
      continue;
    }
    // Prose detection: heuristic only kicks in for the first tab or
    // tabs whose name matches README/Instructions/etc. A narrow 1-2
    // column data tab buried in the middle of the workbook should NOT
    // be silently demoted to notes by the prose ratio alone.
    const proseEligible = tabIdx === 0 || README_RE.test(tab.name);
    if (README_RE.test(tab.name) || (proseEligible && looksLikeProseTab(headers, rows))) {
      tableTabs.push({ tableId: tab.gid, name: tab.name, intent: "notes", rowCount: rows.length });
      const content = collectProseContent(headers, rows);
      if (content) importNotes.push({ tab: tab.name, content });
      continue;
    }
    const cls = classifyTab(tab.name, headers);
    totalSeen += rows.length;
    tableTabs.push({ tableId: tab.gid, name: tab.name, intent: cls.intent, rowCount: rows.length });
    if (cls.intent === "notes") {
      const content = collectProseContent(headers, rows);
      if (content) importNotes.push({ tab: tab.name, content });
      continue;
    }
    prepped.push({ gid: tab.gid, name: tab.name, intent: cls.intent, subkind: cls.subkind, headers, rows });
  }

  // If discovery returned tabs but every fetch failed, the sheet is
  // almost certainly private — surface the fix-it tip the same way
  // the zero-tab branch does.
  if (tabs.length > 0 && tabsFetched === 0) {
    return {
      firms: [],
      totalSeen: 0,
      tableTabs,
      errors: [
        "sheet_not_public",
        "fix:Set the sheet's share setting to 'Anyone with the link can view' and retry.",
      ],
    };
  }

  // ---- Pass 2a: extract firms + people first so `nameKeyByNorm` is
  // fully populated before any metrics tab runs its name-based join.
  for (const t of prepped) {
    if (t.intent === "firms") {
      extractFirms(t.rows, t.headers, url, t.subkind, firms, nameKeyByNorm, seenFirmKeys);
    } else if (t.intent === "leads") {
      extractPeople(t.rows, t.headers, url, people, seenPersonKeys);
    }
  }
  // ---- Pass 2b: now process metrics-style tabs with the full name map.
  // Fuzzy-match cache shared across every metrics tab in the workbook.
  const fuzzyCache = new Map<string, string | null>();
  const pending: PendingMetric[] = [];
  for (const t of prepped) {
    switch (t.intent) {
      case "firm_metrics":
        extractFirmMetrics(t.rows, t.headers, t.name, url, metrics, pending, nameKeyByNorm, fuzzyCache);
        break;
      case "firm_kpi":
        extractFirmKpi(t.rows, t.headers, url, metrics, pending, nameKeyByNorm, fuzzyCache);
        break;
      case "firm_geo":
        extractFirmGeo(t.rows, t.headers, url, metrics, pending, nameKeyByNorm, fuzzyCache);
        break;
      default:
        break;
    }
  }

  // ---- Pass 2c: AI arbitration over unresolved names. Each unique
  // unresolved name pays at most one aiArbitrate call (cached in
  // `fuzzyCache`). Resolved metrics get promoted into `metrics`;
  // unresolved ones are dropped silently by the filter below.
  if (pending.length) {
    const knownDisplayByNorm = new Map<string, string>();
    for (const f of firms) {
      const n = normalizeFirmName(f.name);
      if (n && !knownDisplayByNorm.has(n)) knownDisplayByNorm.set(n, f.name);
    }
    const uniqueUnresolved = new Map<string, string>(); // norm → rawName (first seen)
    for (const p of pending) if (!uniqueUnresolved.has(p.norm)) uniqueUnresolved.set(p.norm, p.rawName);
    for (const [norm, rawName] of uniqueUnresolved) {
      await arbitrateFirmKey(env, rawName, norm, nameKeyByNorm, fuzzyCache, knownDisplayByNorm);
    }
    for (const p of pending) {
      const key = fuzzyCache.get(p.norm) ?? null;
      if (!key) continue;
      metrics.push({
        firm_import_key: key,
        metric_name: p.metric_name,
        metric_date: p.metric_date,
        dimension: p.dimension ?? null,
        value_num: p.value_num,
        value_text: p.value_text,
        source_url: p.source_url ?? url,
      });
    }
  }

  // Drop metrics that didn't resolve to any firm in this workbook —
  // those would otherwise be orphans the pipeline can't write.
  const knownFirmKeys = new Set(firms.map((f) => f.import_key).filter((k): k is string => !!k));
  const resolvedMetrics = metrics.filter((m) => knownFirmKeys.has(m.firm_import_key));

  return {
    firms: firms as FirmCandidate[],
    people: people as PersonCandidate[],
    metrics: resolvedMetrics,
    importNotes: importNotes.length ? importNotes : undefined,
    totalSeen,
    tableTabs,
    errors: errors.length ? errors : undefined,
  };
}

/** Pick the right value out of a gviz cell for downstream coercion.
 *  Per spec: prefer raw `v` for numeric / date fidelity, but when `f`
 *  carries currency symbols (€, $, £, ¥, etc.) or unit suffixes (M/B/K)
 *  that would let `parseMoney` recover the original currency code, use
 *  `f` instead. This is the narrow exception the task spec calls out
 *  for "use formatted f only as fallback for currency-string parsing". */
const CURRENCY_F_RE = /[€$£¥₹₽₩฿]|\b(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|CNY|INR)\b|\d\s*[MBK]\b/i;
function metricCellValue(cell: { v: unknown; f: unknown } | null): unknown {
  if (!cell) return undefined;
  const f = cell.f;
  const v = cell.v;
  if (typeof f === "string" && CURRENCY_F_RE.test(f)) return f;
  return v ?? f;
}

/** Aggregate prose-like cell content from a notes tab into one body. */
function collectProseContent(headers: string[], rows: ParsedTabRows["rows"]): string {
  const lines: string[] = [];
  if (headers.some((h) => !/^col_\d+$/.test(h) && h.length > 0)) {
    lines.push(headers.join(" | "));
  }
  for (const r of rows) {
    const cells = r.map((c) => (c?.v != null ? String(c.v) : (c?.f != null ? String(c.f) : "")));
    const joined = cells.filter((c) => c.trim().length).join(" | ").trim();
    if (joined) lines.push(joined);
    if (lines.length > 200) break; // hard cap so we don't dump megabytes
  }
  return lines.join("\n").slice(0, 16_000);
}

// ---- Per-tab fetch -------------------------------------------------------

interface ParsedTabRows {
  headers: string[];
  /** Each row: array of {v, f} pairs by column index. */
  rows: Array<Array<{ v: unknown; f: unknown } | null>>;
}

async function fetchTabRows(sheetId: string, gid: string): Promise<ParsedTabRows | null> {
  // gviz first (preserves typed values + formatted strings).
  const gv = await fetchGviz(sheetId, gid);
  if (gv) return gv;
  // CSV fallback.
  const csv = await fetchExport(sheetId, gid, "csv");
  if (csv != null) {
    const parsed = parseDelimited(csv, ",");
    if (looksDegenerate(parsed, csv)) {
      const tsv = await fetchExport(sheetId, gid, "tsv");
      if (tsv != null) {
        const tparsed = parseDelimited(tsv, "\t");
        if (tparsed.headers.length > parsed.headers.length) return tparsed;
      }
    }
    if (parsed.headers.length) return parsed;
  }
  return null;
}

async function fetchGviz(sheetId: string, gid: string): Promise<ParsedTabRows | null> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
  const text = await fetchText(url);
  if (!text) return null;
  const m = text.match(/google\.visualization\.Query\.setResponse\((\{[\s\S]*\})\)/);
  if (!m) return null;
  let payload: unknown;
  try { payload = JSON.parse(m[1]); } catch { return null; }
  const table = (payload as { table?: GVizTable }).table;
  if (!table || !Array.isArray(table.cols) || !Array.isArray(table.rows)) return null;

  const colCount = table.cols.length;
  let headers = table.cols.map((c) => (c.label || "").trim());
  let dataRows = table.rows;

  // `parsedNumHeaders` is gviz's frozen-row hint. >1 means a multi-row
  // header block (e.g. "Q1 2024" spanning sub-columns "Deals", "Exits"
  // on row 2). We need to reconstruct each column's header as the
  // joined non-blank cells from rows 0..frozen-1, with merge spans
  // (table.mergeCells) propagated left-to-right across the spanned
  // columns so column 1/2/3 all see "Q1 2024" before their own
  // sub-header gets appended.
  const frozen = typeof table.parsedNumHeaders === "number" ? table.parsedNumHeaders : 0;
  const allLabelsBlank = headers.every((h) => !h);

  if (frozen > 0 && dataRows.length >= frozen) {
    headers = reconstructFrozenHeaders(dataRows.slice(0, frozen), table.mergeCells, colCount);
    dataRows = dataRows.slice(frozen);
  } else if (allLabelsBlank && dataRows.length) {
    headers = (dataRows[0].c ?? []).map((c) => (c?.v != null ? String(c.v).trim() : ""));
    dataRows = dataRows.slice(1);
  }
  headers = headers.map((h, i) => h || `col_${i}`);

  const rows: ParsedTabRows["rows"] = dataRows.map((r) => {
    const cells = r.c ?? [];
    const out: Array<{ v: unknown; f: unknown } | null> = [];
    for (let i = 0; i < headers.length; i++) {
      const c = cells[i];
      out.push(c ? { v: c.v ?? null, f: c.f ?? null } : null);
    }
    return out;
  });
  return { headers, rows };
}

/** Reconstruct a single header label per column from a multi-row frozen
 *  header block. Applies gviz `mergeCells` spans so that e.g. a 1×3
 *  merged "Q1 2024" cell propagates across cols 0,1,2 before each
 *  column's own sub-header gets appended (` › `-joined). */
function reconstructFrozenHeaders(
  headerRows: GVizTable["rows"],
  mergeCells: GVizMerge[] | undefined,
  colCount: number,
): string[] {
  const grid: string[][] = headerRows.map((r) => {
    const out: string[] = [];
    const cs = r.c ?? [];
    for (let i = 0; i < colCount; i++) {
      const c = cs[i];
      out.push(c?.v != null ? String(c.v).trim() : (c?.f != null ? String(c.f).trim() : ""));
    }
    return out;
  });
  // Apply merges — gviz `mergeCells[*]` is {startRow, startColumn,
  // numRows, numColumns} in 0-indexed grid coords. Only merges that
  // sit inside the header rows matter.
  for (const mc of mergeCells ?? []) {
    if (mc.startRow >= grid.length) continue;
    const endRow = Math.min(grid.length, mc.startRow + (mc.numRows ?? 1));
    const endCol = Math.min(colCount, mc.startColumn + (mc.numColumns ?? 1));
    const v = grid[mc.startRow]?.[mc.startColumn] ?? "";
    if (!v) continue;
    for (let r = mc.startRow; r < endRow; r++) {
      for (let c = mc.startColumn; c < endCol; c++) {
        if (!grid[r][c]) grid[r][c] = v;
      }
    }
  }
  const out: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (let r = 0; r < grid.length; r++) {
      const v = grid[r][c];
      if (!v || seen.has(v)) continue;
      seen.add(v);
      parts.push(v);
    }
    out.push(parts.join(" › "));
  }
  return out;
}

async function fetchExport(sheetId: string, gid: string, format: "csv" | "tsv"): Promise<string | null> {
  return fetchText(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=${format}&gid=${gid}`);
}

async function fetchText(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function parseDelimited(raw: string, sep: string): ParsedTabRows {
  const lines = splitCsvLines(raw);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0], sep).map((h, i) => h.trim() || `col_${i}`);
  const rows: ParsedTabRows["rows"] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], sep);
    if (cells.every((c) => !c || !c.trim())) continue;
    rows.push(cells.map((c) => ({ v: c, f: null })));
  }
  return { headers, rows };
}

function splitCsvLines(s: string): string[] {
  // Handle quoted newlines.
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQ && s[i + 1] === '"') { cur += '""'; i += 1; continue; }
      inQ = !inQ; cur += ch; continue;
    }
    if (!inQ && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && s[i + 1] === "\n") i += 1;
      if (cur.length) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

function parseCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i += 1; continue; }
      inQ = !inQ; continue;
    }
    if (!inQ && ch === sep) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function looksDegenerate(parsed: ParsedTabRows, raw: string): boolean {
  return parsed.headers.length <= 1 || (parsed.rows.length <= 1 && raw.length > 200);
}

function looksLikeProseTab(headers: string[], rows: ParsedTabRows["rows"]): boolean {
  // ≤2 columns AND most cells are long text strings → README/instructions.
  if (headers.length > 2) return false;
  if (!rows.length) return false;
  let prose = 0;
  for (const r of rows) {
    const txt = r.map((c) => (c?.v != null ? String(c.v) : "")).join(" ").trim();
    if (txt.length > 80 && /\s/.test(txt)) prose += 1;
  }
  return prose / rows.length > 0.7;
}

// ---- Per-intent extractors ----------------------------------------------

function extractFirms(
  rows: ParsedTabRows["rows"],
  headers: string[],
  sourceUrl: string,
  subkind: string | undefined,
  out: KeyedFirmCandidate[],
  nameKeyByNorm: Map<string, string>,
  seen: Set<string>,
): void {
  for (const r of rows) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      const cell = r[i];
      // Prefer formatted string `f` so currency cells like "€80M"
      // survive into rowToCandidate's parseUsdAmount; raw `v` for
      // numbers/dates which f-string would mangle (e.g. "€80,000,000.00"
      // is fine, but a date as "2024-01-01" or epoch number both round-trip).
      const v = metricCellValue(cell);
      if (v != null && v !== "") obj[headers[i] || `col_${i}`] = v;
    }
    const built = rowToCandidate(obj, sourceUrl);
    if (!built) continue;
    const cand = built.candidate as KeyedFirmCandidate;
    if (subkind) cand.kind = subkind;
    const norm = normalizeFirmName(cand.name);
    if (!norm) continue;
    const key = `name:${norm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cand.import_key = key;
    nameKeyByNorm.set(norm, key);
    out.push(cand);
  }
}

function extractPeople(
  rows: ParsedTabRows["rows"],
  headers: string[],
  sourceUrl: string,
  out: KeyedPersonCandidate[],
  seen: Set<string>,
): void {
  // Use the smarter auto-mapper for people tabs.
  const samples = buildSamples(
    headers,
    rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]?.v != null ? String(r[i]?.v) : ""]))),
  );
  const { map } = autoMapHeaders(headers, samples);

  for (const r of rows) {
    const person: KeyedPersonCandidate = { name: "", source_url: sourceUrl };
    for (let i = 0; i < headers.length; i++) {
      const cell = r[i];
      const v = metricCellValue(cell);
      if (v == null || v === "") continue;
      const m = map[headers[i]];
      if (!m) continue;
      applyPersonField(person, m, String(v));
    }
    if (!person.name) continue;
    const dedupeKey = (person.email || person.linkedin_url || `${person.name}|${person.org ?? ""}`).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    person.import_key = `person:${dedupeKey}`;
    out.push(person);
  }
}

function applyPersonField(p: KeyedPersonCandidate, m: MappedField, v: string): void {
  const s = v.trim();
  if (!s) return;
  if (m.entity === "leads") {
    switch (m.field) {
      case "name": p.name = s; break;
      case "email": p.email = s.toLowerCase(); break;
      case "title": p.title = s; break;
      case "org": p.org = s; break;
      case "phone": p.phone = s; break;
      case "linkedin_url": p.linkedin_url = s; break;
      case "twitter_url": p.twitter_url = s; break;
    }
  } else if (m.entity === "firms") {
    // A "company"/"firm" column on a people tab → treat as org.
    if (m.field === "name" && !p.org) p.org = s;
    if (m.field === "linkedin_url" && !p.linkedin_url) p.linkedin_url = s;
    if (m.field === "hq_country_iso2" && !p.country_iso2) {
      const iso = parseCountryIso2(s); if (iso) p.country_iso2 = iso;
    }
  }
}

function extractFirmMetrics(
  rows: ParsedTabRows["rows"],
  headers: string[],
  tabName: string,
  sourceUrl: string,
  out: NonNullable<FirmlistImportResult["metrics"]>,
  pending: PendingMetric[],
  nameKeyByNorm: Map<string, string>,
  fuzzyCache: Map<string, string | null>,
): void {
  // Locate firm-name column, period column, and metric value columns.
  const samples = buildSamples(
    headers,
    rows.slice(0, 20).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]?.v != null ? String(r[i]?.v) : ""]))),
  );
  const { map } = autoMapHeaders(headers, samples);

  const nameCol = headers.find((h) => map[h]?.entity === "firms" && map[h]?.field === "name");
  if (!nameCol) return;
  const periodCol = headers.find((h) => /\b(year|month|quarter|period|date|fy)\b/i.test(h));

  // Metric columns: any header mapped to firm_metrics.* OR a numeric
  // header named like a year ("2022", "FY24") — the latter pattern is
  // common in pivoted "wide" sheets where each column is a year.
  type MetricCol = { header: string; metric: string; period: string | null; dimension?: string | null };
  const metricCols: MetricCol[] = [];
  for (const h of headers) {
    const m = map[h];
    if (m?.entity === "firm_metrics") {
      // Period derived from the period column for each row (handled below).
      metricCols.push({ header: h, metric: m.field, period: null });
      continue;
    }
    // Wide-pivot year header → metric=aum_usd (default) or inferred from
    // tabName ("Deals by year" → deals_count etc.).
    const y = parseYear(h);
    if (y) {
      const inferred = inferMetricFromTabName(tabName);
      metricCols.push({ header: h, metric: inferred, period: String(y) });
    }
  }
  if (!metricCols.length) return;

  for (const r of rows) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      const cell = r[i];
      const v = metricCellValue(cell);
      if (v != null && v !== "") obj[headers[i]] = String(v);
    }
    const rawName = obj[nameCol];
    if (!rawName) continue;
    const norm = normalizeFirmName(rawName);
    if (!norm) continue;
    const firmKey = lookupFirmKey(norm, nameKeyByNorm, fuzzyCache);

    const rowPeriod = periodCol ? normalizePeriod(obj[periodCol]) : null;
    for (const c of metricCols) {
      const raw = obj[c.header];
      if (!raw) continue;
      const period = c.period ?? rowPeriod ?? "YTD";
      const { value_num, value_text } = parseMetricValue(raw);
      if (value_num == null && !value_text) continue;
      const payload = {
        metric_name: c.metric,
        metric_date: period,
        dimension: c.dimension ?? null,
        value_num,
        value_text,
        source_url: sourceUrl,
      };
      if (firmKey) {
        out.push({ firm_import_key: firmKey, ...payload });
      } else {
        // Deferred to Pass 2c (aiArbitrate). Name may still resolve.
        pending.push({ rawName, norm, ...payload });
      }
    }
  }
}

function extractFirmKpi(
  rows: ParsedTabRows["rows"],
  headers: string[],
  sourceUrl: string,
  out: NonNullable<FirmlistImportResult["metrics"]>,
  pending: PendingMetric[],
  nameKeyByNorm: Map<string, string>,
  fuzzyCache: Map<string, string | null>,
): void {
  // KPI tabs are snapshots — write each mapped metric with period=YTD.
  const samples = buildSamples(
    headers,
    rows.slice(0, 20).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]?.v != null ? String(r[i]?.v) : ""]))),
  );
  const { map } = autoMapHeaders(headers, samples);
  const nameCol = headers.find((h) => map[h]?.entity === "firms" && map[h]?.field === "name");
  if (!nameCol) return;

  for (const r of rows) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      const cell = r[i];
      const v = metricCellValue(cell);
      if (v != null && v !== "") obj[headers[i]] = String(v);
    }
    const rawName = obj[nameCol];
    if (!rawName) continue;
    const norm = normalizeFirmName(rawName);
    if (!norm) continue;
    const firmKey = lookupFirmKey(norm, nameKeyByNorm, fuzzyCache);
    for (const h of headers) {
      const m = map[h];
      if (!m || m.entity !== "firm_metrics") continue;
      const raw = obj[h];
      if (!raw) continue;
      const { value_num, value_text } = parseMetricValue(raw);
      if (value_num == null && !value_text) continue;
      const payload = {
        metric_name: m.field,
        metric_date: "YTD",
        dimension: null,
        value_num,
        value_text,
        source_url: sourceUrl,
      };
      if (firmKey) out.push({ firm_import_key: firmKey, ...payload });
      else pending.push({ rawName, norm, ...payload });
    }
  }
}

function extractFirmGeo(
  rows: ParsedTabRows["rows"],
  headers: string[],
  sourceUrl: string,
  out: NonNullable<FirmlistImportResult["metrics"]>,
  pending: PendingMetric[],
  nameKeyByNorm: Map<string, string>,
  fuzzyCache: Map<string, string | null>,
): void {
  // Geo tabs come in two shapes:
  //   (a) Long: firm | country | pct
  //   (b) Wide: firm | US | UK | DE | ...  (each column = country)
  // We handle both.
  const samples = buildSamples(
    headers,
    rows.slice(0, 20).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]?.v != null ? String(r[i]?.v) : ""]))),
  );
  const { map } = autoMapHeaders(headers, samples);
  const nameCol = headers.find((h) => map[h]?.entity === "firms" && map[h]?.field === "name");
  if (!nameCol) return;

  const countryCol = headers.find((h) => /\b(country|region|geo)\b/i.test(h) && h !== nameCol);
  const pctCol = headers.find((h) => /\b(%|share|pct|percent|allocation)\b/i.test(h));

  // Wide-mode country columns: header matching a country (iso2 or
  // name). Skip the nameCol itself.
  const wideCountryCols: Array<{ header: string; iso2: string }> = [];
  if (!countryCol) {
    for (const h of headers) {
      if (h === nameCol) continue;
      const iso = parseCountryIso2(h);
      if (iso) wideCountryCols.push({ header: h, iso2: iso });
    }
  }

  for (const r of rows) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      const cell = r[i];
      const v = metricCellValue(cell);
      if (v != null && v !== "") obj[headers[i]] = String(v);
    }
    const rawName = obj[nameCol];
    if (!rawName) continue;
    const norm = normalizeFirmName(rawName);
    if (!norm) continue;
    const firmKey = lookupFirmKey(norm, nameKeyByNorm, fuzzyCache);

    const pushGeo = (dim: string, value_num: number, value_text: string): void => {
      const payload = {
        metric_name: "geo_pct",
        metric_date: "YTD",
        dimension: dim,
        value_num,
        value_text,
        source_url: sourceUrl,
      };
      if (firmKey) out.push({ firm_import_key: firmKey, ...payload });
      else pending.push({ rawName, norm, ...payload });
    };

    if (countryCol && pctCol) {
      const iso = parseCountryIso2(obj[countryCol]);
      const { value_num } = parseMetricValue(obj[pctCol]);
      if (iso && value_num != null) pushGeo(iso, value_num, obj[pctCol]);
    } else if (wideCountryCols.length) {
      for (const c of wideCountryCols) {
        const raw = obj[c.header];
        if (!raw) continue;
        const { value_num } = parseMetricValue(raw);
        if (value_num == null) continue;
        pushGeo(c.iso2, value_num, raw);
      }
    }
  }
}

// ---- coercion helpers ---------------------------------------------------

function parseMetricValue(raw: string): { value_num: number | null; value_text: string | null } {
  const s = raw.trim();
  if (!s) return { value_num: null, value_text: null };
  // Bare percentage: "23%", "23.4 %".
  const pct = /^([\d.,]+)\s*%$/.exec(s);
  if (pct) {
    const n = parseFloat(pct[1].replace(/,/g, ""));
    return { value_num: Number.isFinite(n) ? n : null, value_text: s };
  }
  // Currency / scaled number via coercer.
  const m = parseMoney(s);
  if (m.native != null) return { value_num: m.native, value_text: s };
  // Bare number with commas / spaces.
  const n = parseFloat(s.replace(/[,\u00a0\u202f\u2009 ']/g, ""));
  if (Number.isFinite(n)) return { value_num: n, value_text: s };
  return { value_num: null, value_text: s };
}

function inferMetricFromTabName(tabName: string): string {
  const n = tabName.toLowerCase();
  if (/exit/.test(n)) return "exits_count";
  if (/deal|invest/.test(n)) return "deals_count";
  if (/fund.*size|vintage|raise/.test(n)) return "fund_size_usd";
  if (/fund/.test(n)) return "new_funds";
  if (/aum|assets/.test(n)) return "aum_usd";
  return "aum_usd";
}

function normalizePeriod(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Already ISO-ish: "2024-01-01", "2024-01", "2024-Q1", "2024".
  if (/^\d{4}(-\d{2}(-\d{2})?|-Q[1-4])?$/.test(s)) return s;
  const y = parseYear(s);
  if (y) {
    const q = /Q([1-4])/i.exec(s); if (q) return `${y}-Q${q[1]}`;
    const mo = /\b(0[1-9]|1[0-2])\b/.exec(s); if (mo) return `${y}-${mo[1]}`;
    return String(y);
  }
  return s;
}

/** Three-tier cross-tab firm name resolution:
 *   1. Strict normalized-name match (handled inline in callers).
 *   2. Local fuzzy: substring containment + bounded Levenshtein. Strong
 *      hits (score ≥ STRONG_FUZZY) accepted without AI; weak hits
 *      (score in [WEAK_FUZZY, STRONG_FUZZY)) are kicked up to AI
 *      arbitration.
 *   3. AI arbitration via `aiArbitrate` over the workbook's known
 *      firm names. Confirmed matches (yes, conf ≥ 0.8) win; everything
 *      else is dropped. Results are memoized in `cache` so each unique
 *      unresolved name pays at most one AI call per workbook.
 *
 *  This is the "Vectorize + AI arbitration" path the task spec calls
 *  for, adapted to the workbook-local case: within a single sheet the
 *  candidate space is ≤O(50) firms so we can score every candidate
 *  cheaply on the worker, then defer to the LLM only when local
 *  similarity is ambiguous. Outside-workbook resolution against the
 *  global VEC_FIRMS index happens later in the pipeline's standard
 *  dedupe path (dedupe/vector.ts) when each firm is upserted. */
const STRONG_FUZZY = 0.85;
const WEAK_FUZZY = 0.55;

interface FuzzyHit { key: string; candidateNorm: string; score: number }

function bestFuzzyCandidate(norm: string, nameKeyByNorm: Map<string, string>): FuzzyHit | null {
  let best: FuzzyHit | null = null;
  for (const [k, v] of nameKeyByNorm.entries()) {
    if (k.length >= 4 && norm.length >= 4) {
      if (k.includes(norm) || norm.includes(k)) {
        const score = Math.min(k.length, norm.length) / Math.max(k.length, norm.length);
        if (score >= WEAK_FUZZY && (!best || score > best.score)) {
          best = { key: v, candidateNorm: k, score };
        }
        continue;
      }
    }
    if (Math.abs(k.length - norm.length) > 4) continue;
    const d = editDistance(k, norm);
    const score = 1 - d / Math.max(k.length, norm.length);
    if (score >= WEAK_FUZZY && (!best || score > best.score)) {
      best = { key: v, candidateNorm: k, score };
    }
  }
  return best;
}

/** Synchronous strict+strong-fuzzy lookup. Returns a key for
 *  high-confidence matches only; marginal candidates are deferred to
 *  the async `arbitrateFirmKey` path below. */
function lookupFirmKey(
  norm: string,
  nameKeyByNorm: Map<string, string>,
  cache: Map<string, string | null>,
): string | null {
  if (!norm) return null;
  const strict = nameKeyByNorm.get(norm);
  if (strict) return strict;
  if (cache.has(norm)) return cache.get(norm) ?? null;
  const hit = bestFuzzyCandidate(norm, nameKeyByNorm);
  if (hit && hit.score >= STRONG_FUZZY) {
    cache.set(norm, hit.key);
    return hit.key;
  }
  return null; // marginal or no candidate — arbitration handled separately.
}

/** Async arbitration pass — called once per unique unresolved name
 *  after sync extraction. Asks the LLM whether `rawName` and the top
 *  local-fuzzy candidate refer to the same firm. Side-effect: writes
 *  the resolution (key or null) into the shared `cache`, so any
 *  subsequent strict-lookup of the same norm returns the arbitrated
 *  key. */
async function arbitrateFirmKey(
  env: Env,
  rawName: string,
  norm: string,
  nameKeyByNorm: Map<string, string>,
  cache: Map<string, string | null>,
  knownFirms: Map<string, string>, // norm → display name
): Promise<string | null> {
  if (cache.has(norm)) return cache.get(norm) ?? null;
  let hit = bestFuzzyCandidate(norm, nameKeyByNorm);

  // Vectorize fallback: when local fuzzy can't find anything in the
  // workbook (or only a marginal candidate), embed the raw name and
  // query VEC_FIRMS. If a returned firm's metadata.name normalizes to
  // a name we already have in the workbook map, treat it as the
  // candidate and let aiArbitrate confirm. This gives us cross-tab
  // resolution for hard variants (e.g. "Acme Cap." ↔ "Acme Capital
  // Partners LLP") that local edit distance can't span.
  if (!hit || hit.score < WEAK_FUZZY) {
    const vecHit = await tryVectorizeFirmHit(env, rawName, nameKeyByNorm);
    if (vecHit) hit = vecHit;
  }

  if (!hit || hit.score < WEAK_FUZZY) {
    cache.set(norm, null);
    return null;
  }
  const candidateDisplay = knownFirms.get(hit.candidateNorm) ?? hit.candidateNorm;
  try {
    const arb = await aiArbitrate(env, rawName, candidateDisplay);
    if (arb.match === "yes" && arb.confidence >= 0.8) {
      cache.set(norm, hit.key);
      return hit.key;
    }
  } catch {
    // aiArbitrate failures already self-log; treat as no-match.
  }
  cache.set(norm, null);
  return null;
}

/** Vectorize-backed cross-tab name resolver. Queries VEC_FIRMS for the
 *  raw name's embedding, then keeps the top match only if its metadata
 *  name (or id) normalizes back into the current workbook's firm map.
 *  Returns a FuzzyHit-shaped result so it slots into the same
 *  arbitration path as local fuzzy candidates. Best-effort: any
 *  binding/budget/embed failure returns null and falls through. */
async function tryVectorizeFirmHit(
  env: Env,
  rawName: string,
  nameKeyByNorm: Map<string, string>,
): Promise<{ key: string; candidateNorm: string; score: number } | null> {
  try {
    const idx = (env as Env & { VEC_FIRMS?: { query: (...args: unknown[]) => Promise<unknown> } }).VEC_FIRMS;
    if (!idx) return null;
    const { aiEmbed } = await import("../../../ai/extract");
    const { assertBudget } = await import("../../../ai/budget");
    const budget = await assertBudget(env, "vectorize");
    if (!budget.ok) return null;
    const vec = await aiEmbed(env, rawName);
    if (!vec) return null;
    const r = await idx.query(vec, { topK: 5, returnMetadata: "all" });
    const matches: Array<{ score: number; metadata?: Record<string, unknown> }> =
      (r as { matches?: Array<{ score: number; metadata?: Record<string, unknown> }> })?.matches ?? [];
    for (const m of matches) {
      const metaName = String((m.metadata?.name as string | undefined) ?? "");
      if (!metaName) continue;
      const candidateNorm = normalizeFirmName(metaName);
      const key = candidateNorm ? nameKeyByNorm.get(candidateNorm) : undefined;
      if (key && m.score >= 0.8) {
        return { key, candidateNorm, score: m.score };
      }
    }
  } catch {
    // VEC_FIRMS not bound / budget exhausted / network — fall through.
  }
  return null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

function normalizeFirmName(name: string | null | undefined): string {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    // Strip only generic legal-form suffixes — preserve high-entropy
    // tokens like "Capital", "Ventures", "Fund", "Partners" since
    // distinct firms commonly differ only on those words
    // (e.g. "Acme Capital" vs "Acme Ventures").
    .replace(/\b(the|inc|llc|ltd|lp|llp|gmbh|sa|sarl|srl|corp|co|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- URL parsing --------------------------------------------------------

function parseSheetUrl(url: string): { sheetId: string; gid: string | null } | null {
  const m = url.match(/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  let gid: string | null = null;
  const hash = url.split("#")[1] ?? "";
  const query = url.split("?")[1] ?? "";
  const gidMatch = (hash + "&" + query).match(/gid=(\d+)/);
  if (gidMatch) gid = gidMatch[1];
  return { sheetId: m[1], gid };
}

// ---- gviz table shape ---------------------------------------------------

interface GVizTable {
  cols: Array<{ id?: string; label?: string; type?: string }>;
  rows: Array<{ c: Array<{ v?: unknown; f?: unknown } | null> }>;
  parsedNumHeaders?: number;
  mergeCells?: GVizMerge[];
}

interface GVizMerge {
  startRow: number;
  startColumn: number;
  numRows: number;
  numColumns: number;
}
