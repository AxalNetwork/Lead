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

const UA = "Mozilla/5.0 AIDataSignalBot/1.0";
const README_RE = /\b(read\s*me|readme|instructions?|how\s*to|getting\s*started|sign[\s_-]*up|signup|first\s*tab|welcome|cover\s*page?|disclaimer|tos|terms)\b/i;

export async function importFirms(url: string, _env: Env): Promise<FirmlistImportResult> {
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
  for (const tab of tabs) {
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
    if (README_RE.test(tab.name) || looksLikeProseTab(headers, rows)) {
      tableTabs.push({ tableId: tab.gid, name: tab.name, intent: "notes", rowCount: rows.length });
      continue;
    }
    const cls = classifyTab(tab.name, headers);
    totalSeen += rows.length;
    tableTabs.push({ tableId: tab.gid, name: tab.name, intent: cls.intent, rowCount: rows.length });
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
  for (const t of prepped) {
    switch (t.intent) {
      case "firm_metrics":
        extractFirmMetrics(t.rows, t.headers, t.name, url, metrics, nameKeyByNorm);
        break;
      case "firm_kpi":
        extractFirmKpi(t.rows, t.headers, url, metrics, nameKeyByNorm);
        break;
      case "firm_geo":
        extractFirmGeo(t.rows, t.headers, url, metrics, nameKeyByNorm);
        break;
      default:
        break;
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
    totalSeen,
    tableTabs,
    errors: errors.length ? errors : undefined,
  };
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

  // Honor `parsedNumHeaders` (frozen-rows hint from gviz) — when >0 the
  // first N data rows are actually headers. The default case is the
  // existing quirk where cols[*].label is blank and the first data row
  // carries the headers.
  let headers = table.cols.map((c) => (c.label || "").trim());
  let dataRows = table.rows;
  const frozen = typeof table.parsedNumHeaders === "number" ? table.parsedNumHeaders : 0;
  if (frozen > 0 && dataRows.length >= frozen) {
    headers = (dataRows[0].c ?? []).map((c) => (c?.v != null ? String(c.v).trim() : ""));
    dataRows = dataRows.slice(frozen);
  } else if (headers.every((h) => !h) && dataRows.length) {
    headers = (dataRows[0].c ?? []).map((c) => (c?.v != null ? String(c.v).trim() : ""));
    dataRows = dataRows.slice(1);
  }
  // Backfill blank headers with `col_{i}` so auto-mapper still indexes.
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
      const v = cell?.f ?? cell?.v;
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
      const v = cell?.f ?? cell?.v;
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
  nameKeyByNorm: Map<string, string>,
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
      const v = cell?.f ?? cell?.v;
      if (v != null && v !== "") obj[headers[i]] = String(v);
    }
    const rawName = obj[nameCol];
    if (!rawName) continue;
    const norm = normalizeFirmName(rawName);
    if (!norm) continue;
    const firmKey = nameKeyByNorm.get(norm);
    if (!firmKey) continue; // Only emit when the firm exists in a firms-intent tab.

    const rowPeriod = periodCol ? normalizePeriod(obj[periodCol]) : null;
    for (const c of metricCols) {
      const raw = obj[c.header];
      if (!raw) continue;
      const period = c.period ?? rowPeriod ?? "YTD";
      const { value_num, value_text } = parseMetricValue(raw);
      if (value_num == null && !value_text) continue;
      out.push({
        firm_import_key: firmKey,
        metric_name: c.metric,
        metric_date: period,
        dimension: c.dimension ?? null,
        value_num,
        value_text,
        source_url: sourceUrl,
      });
    }
  }
}

function extractFirmKpi(
  rows: ParsedTabRows["rows"],
  headers: string[],
  sourceUrl: string,
  out: NonNullable<FirmlistImportResult["metrics"]>,
  nameKeyByNorm: Map<string, string>,
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
      const v = cell?.f ?? cell?.v;
      if (v != null && v !== "") obj[headers[i]] = String(v);
    }
    const rawName = obj[nameCol];
    if (!rawName) continue;
    const norm = normalizeFirmName(rawName);
    const firmKey = nameKeyByNorm.get(norm);
    if (!firmKey) continue;
    for (const h of headers) {
      const m = map[h];
      if (!m || m.entity !== "firm_metrics") continue;
      const raw = obj[h];
      if (!raw) continue;
      const { value_num, value_text } = parseMetricValue(raw);
      if (value_num == null && !value_text) continue;
      out.push({
        firm_import_key: firmKey,
        metric_name: m.field,
        metric_date: "YTD",
        dimension: null,
        value_num,
        value_text,
        source_url: sourceUrl,
      });
    }
  }
}

function extractFirmGeo(
  rows: ParsedTabRows["rows"],
  headers: string[],
  sourceUrl: string,
  out: NonNullable<FirmlistImportResult["metrics"]>,
  nameKeyByNorm: Map<string, string>,
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
      const v = cell?.f ?? cell?.v;
      if (v != null && v !== "") obj[headers[i]] = String(v);
    }
    const rawName = obj[nameCol];
    if (!rawName) continue;
    const norm = normalizeFirmName(rawName);
    const firmKey = nameKeyByNorm.get(norm);
    if (!firmKey) continue;

    if (countryCol && pctCol) {
      const iso = parseCountryIso2(obj[countryCol]);
      const { value_num } = parseMetricValue(obj[pctCol]);
      if (iso && value_num != null) {
        out.push({
          firm_import_key: firmKey,
          metric_name: "geo_pct",
          metric_date: "YTD",
          dimension: iso,
          value_num,
          value_text: obj[pctCol],
          source_url: sourceUrl,
        });
      }
    } else if (wideCountryCols.length) {
      for (const c of wideCountryCols) {
        const raw = obj[c.header];
        if (!raw) continue;
        const { value_num } = parseMetricValue(raw);
        if (value_num == null) continue;
        out.push({
          firm_import_key: firmKey,
          metric_name: "geo_pct",
          metric_date: "YTD",
          dimension: c.iso2,
          value_num,
          value_text: raw,
          source_url: sourceUrl,
        });
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
}
