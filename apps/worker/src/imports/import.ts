// import_file queue consumer (Task #2 v2).
//
// Re-parses the upload from R2, looks up per-tab classification + maps from
// file_import_tabs (set by parse.ts and possibly overridden via the
// confirm-map endpoint), then routes each tab to the correct destination:
//
//   intent='firms'        → upsertFirm (kind='gov_fund' if intent_subkind set)
//   intent='firm_metrics' → INSERT firm_metrics rows keyed on (firm_id,metric,period,dimension)
//   intent='firm_geo'     → INSERT firm_metrics with metric=geo_pct, dimension=ISO2
//   intent='firm_kpi'     → INSERT firm_metrics with period='YTD'
//   intent='leads'        → existing lead-insert pathway
//   intent='notes' | 'discard' → skipped, counted in summary_json
//
// Cell values are passed through ./coercers (money/year/stage/country/url/bool)
// before persistence so spreadsheet exports with "$1.2B", "🇺🇸", or
// "Series A, B" land as canonical numeric / ISO2 / array values.

import type { Env, JobMessage, JobKind } from "../types";
import { parseCsv, type ParsedTable } from "./csv";
import { parseSpreadsheet } from "./xlsx_parser";
import { parsePdfTables } from "./pdf_parser";
import { extractTablesFromImage, extractTablesFromImagePdf } from "./vision_pdf";
import type { Entity, MappedField } from "./auto_map";
import { rowToCandidate } from "../scraper/parsers/firmlists/_helpers";
import { upsertFirm } from "../scraper/firms_upsert";
import type { FirmCandidate } from "../scraper/parsers/firmlists/types";
import { resolveIncoming, buildCanonicalKeys } from "../dedupe";
import { mergeIntoExisting } from "../dedupe/merge";
import { findMatch } from "../dedupe/match";
import type { Lead } from "../db/leads.types";
import { checkAndScrubDnc } from "../compliance/dnc";
import { classifyUrl } from "./url_extract";
import { tosBlockedReason } from "../scraper/tos";
import { detectFormat } from "./format_detect";
import {
  parseMoney, parseMoneyUsd, parseMoneyRange, parseMoneyRangeUsd, parseYear, parseStages,
  parseCountryIso2, parseCountryIso2List, parseUrl, parseBool, isEmptyCell,
} from "./coercers";
import type { TabIntent } from "./tab_intent";
import { looksLikeTypeString } from "../services/csv/headerDetector";

const BATCH_SIZE = 200;

interface FileImportRow {
  id: string;
  filename: string;
  mime: string | null;
  r2_key: string;
  entity: Entity | null;
  scrape_urls: number;
  format: string | null;
  created_by: string | null;
}

interface TabRow {
  id: string;
  tab_index: number;
  sheet_name: string | null;
  page_number: number | null;
  intent: TabIntent;
  intent_subkind: string | null;
  column_map_json: string | null;
}

interface TabSummary {
  index: number;
  sheet: string | null;
  intent: TabIntent;
  intent_subkind: string | null;
  rows_in: number;
  rows_imported: number;
  rows_skipped: number;
  firms_created: number;
  firms_updated: number;
  metrics_inserted: number;
  leads_created: number;
  leads_updated: number;
  errors: string[];
}

export async function processImportFile(env: Env, importId: string, opts: { jobId?: string } = {}): Promise<void> {
  // Cancellation gate: if this job was cancelled before the queue
  // delivered it (e.g. operator re-confirmed mapping via
  // /confirm-map?force=1, which marks pending import_file jobs as
  // 'cancelled'), bail without touching file_imports. The replacement
  // job already updated the row and will run its own processImportFile.
  if (opts.jobId) {
    const job = await env.DB
      .prepare("SELECT status FROM jobs WHERE id = ?")
      .bind(opts.jobId)
      .first<{ status: string }>();
    if (job?.status === "cancelled") return;
  }
  const row = await env.DB
    .prepare("SELECT id, filename, mime, r2_key, entity, scrape_urls, format, created_by FROM file_imports WHERE id = ?")
    .bind(importId)
    .first<FileImportRow>();
  if (!row) throw new Error(`file_import_not_found:${importId}`);

  await env.DB
    .prepare("UPDATE file_imports SET status = 'importing', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), importId)
    .run();

  try {
    // Prefer the parse-time row snapshot persisted to KV by parse.ts so the
    // import operates on the EXACT data the operator reviewed (no re-OCR,
    // no model-output drift). Fall back to re-parsing source bytes only
    // when the snapshot is missing (TTL expiry / legacy uploads).
    // Map<tabIndex, ParsedTable> preserves the original parse-time tab
    // identity so DB tab_index lookups stay aligned even when intermediate
    // tabs lack headers (e.g. notes-only tabs).
    let tablesByIdx = new Map<number, ParsedTable>();
    const snapRaw = await env.SCRAPE_CACHE.get(`upload_rows:${importId}`);
    const headerSnapRaw = await env.SCRAPE_CACHE.get(`upload_tab_previews:${importId}`);
    if (snapRaw && headerSnapRaw) {
      try {
        const tabRowsSnap = JSON.parse(snapRaw) as Record<string, Array<Record<string, string>>>;
        const tabHeadersSnap = JSON.parse(headerSnapRaw) as Record<string, { headers: string[] }>;
        for (const k of Object.keys(tabRowsSnap)) {
          const i = parseInt(k, 10);
          if (Number.isNaN(i)) continue;
          const headers = tabHeadersSnap[k]?.headers ?? [];
          tablesByIdx.set(i, { headers, rows: tabRowsSnap[k] ?? [] });
        }
      } catch { tablesByIdx = new Map(); }
    }
    if (tablesByIdx.size === 0) {
      const obj = await env.UPLOADS.get(row.r2_key);
      if (!obj) throw new Error("upload_object_missing");
      const bytes = await obj.arrayBuffer();
      const reparsed = await parseAllTables(bytes, row, env);
      reparsed.forEach((t, i) => tablesByIdx.set(i, t));
    }
    if (tablesByIdx.size === 0) throw new Error("no_table_found");

    // Load per-tab routing rows (set by parse.ts, possibly overridden by
    // confirm-map). Fall back to single-tab legacy path when missing.
    const tabRowsRaw = await env.DB
      .prepare("SELECT id, tab_index, sheet_name, page_number, intent, intent_subkind, column_map_json FROM file_import_tabs WHERE import_id = ? ORDER BY tab_index")
      .bind(importId).all<TabRow>();
    const tabRows = (tabRowsRaw.results ?? []) as TabRow[];

    const sourceUrl = `upload://${importId}/${row.filename}`;
    const importedFrom = `upload:multi`;
    const summaries: TabSummary[] = [];
    let totalImported = 0, totalFirmsCreated = 0, totalFirmsUpdated = 0;
    let totalMetricsInserted = 0, totalLeadsCreated = 0, totalLeadsUpdated = 0;
    let totalSkipped = 0;
    let firmsCreatedHere = 0, firmsUpdatedHere = 0; // for legacy file_imports counters
    const firmIdsTouched = new Set<number>();
    /** Firm-id resolved from filename for portfolio/metrics fallback. */
    let fallbackFirmId: number | null = null;

    // Iterate by DB tab_index so per-tab intents/maps route to the right
    // snapshot tab even if an earlier tab is empty. Fail fast if the DB
    // references a tab_index the snapshot doesn't have.
    const dbTabIndices = tabRows.map((r) => r.tab_index).sort((a, b) => a - b);
    const allIndices = dbTabIndices.length
      ? dbTabIndices
      : Array.from(tablesByIdx.keys()).sort((a, b) => a - b);
    for (const i of allIndices) {
      const t = tablesByIdx.get(i);
      if (!t) {
        // DB has a tab the snapshot doesn't — refuse to misroute silently.
        throw new Error(`tab_snapshot_missing:${i}`);
      }
      const tabRow = tabRows.find((r) => r.tab_index === i);
      const intent: TabIntent = (tabRow?.intent ?? "firms") as TabIntent;
      const subkind = tabRow?.intent_subkind ?? null;
      const columnMap = parseMap(tabRow?.column_map_json ?? null);
      const sum: TabSummary = {
        index: i,
        sheet: t.sheetName ?? tabRow?.sheet_name ?? null,
        intent,
        intent_subkind: subkind,
        rows_in: t.rows.length,
        rows_imported: 0,
        rows_skipped: 0,
        firms_created: 0,
        firms_updated: 0,
        metrics_inserted: 0,
        leads_created: 0,
        leads_updated: 0,
        errors: [],
      };

      if (intent === "discard" || intent === "notes") {
        sum.rows_skipped = t.rows.length;
        totalSkipped += t.rows.length;
        summaries.push(sum);
        await persistTabResult(env, tabRow?.id, sum);
        continue;
      }

      if (intent === "firms") {
        for (let off = 0; off < t.rows.length; off += BATCH_SIZE) {
          const slice = t.rows.slice(off, off + BATCH_SIZE);
          for (const raw of slice) {
            const projected = projectAndCoerceRow(raw, columnMap, env);
            // Force kind=gov_fund when the tab subkind says so.
            if (subkind === "gov_fund" && !projected.fields.kind) projected.fields.kind = "gov_fund";
            const r = await tryUpsertFirm(env, await projected.awaited(), sourceUrl, importedFrom);
            if (r.action === "created") { sum.firms_created++; firmsCreatedHere++; sum.rows_imported++; }
            else if (r.action === "updated") { sum.firms_updated++; firmsUpdatedHere++; sum.rows_imported++; }
            else if (r.action === "skip") sum.rows_skipped++;
            else if (r.action === "error") { sum.rows_skipped++; sum.errors.push(`firm:${(projected.fields.name ?? "?").slice(0, 40)}`); }
            if (r.firmId != null) {
              firmIdsTouched.add(r.firmId);
              if (fallbackFirmId == null) fallbackFirmId = r.firmId;
            }
          }
          await env.DB.prepare(
            `UPDATE file_imports SET rows_imported = ?, firms_created = ?, firms_updated = ?, updated_at = ? WHERE id = ?`,
          ).bind(
            totalImported + sum.rows_imported,
            totalFirmsCreated + sum.firms_created,
            totalFirmsUpdated + sum.firms_updated,
            new Date().toISOString(), importId,
          ).run();
        }
      } else if (intent === "leads") {
        for (let off = 0; off < t.rows.length; off += BATCH_SIZE) {
          const slice = t.rows.slice(off, off + BATCH_SIZE);
          const inserts: D1PreparedStatement[] = [];
          for (const raw of slice) {
            const projected = projectAndCoerceRow(raw, columnMap, env);
            const fields = (await projected.awaited()).fields;
            const r = await tryInsertLead(env, fields, importId, importedFrom, sourceUrl, inserts);
            if (r === "created") { sum.leads_created++; sum.rows_imported++; }
            else if (r === "merged") { sum.leads_updated++; sum.rows_imported++; }
            else if (r === "skip") sum.rows_skipped++;
            else if (r === "error") { sum.rows_skipped++; sum.errors.push(`lead:${(fields.name ?? "?").slice(0, 40)}`); }
          }
          if (inserts.length) await env.DB.batch(inserts);
        }
      } else if (intent === "firm_metrics" || intent === "firm_kpi" || intent === "firm_geo") {
        // Resolve firm context for metrics rows. Order: explicit `firms.name` /
        // `firms.domain` columns on the row, else fallback to firmIdsTouched
        // first entry, else synthesize from filename.
        for (const raw of t.rows) {
          const projected = await (projectAndCoerceRow(raw, columnMap, env)).awaited();
          const firmId = await resolveFirmIdForMetric(env, projected.fields, firmIdsTouched, fallbackFirmId, row.filename, sourceUrl, importedFrom)
            .then(({ firmId, created }) => {
              if (created) { firmsCreatedHere++; sum.firms_created++; }
              if (firmId != null) {
                firmIdsTouched.add(firmId);
                if (fallbackFirmId == null) fallbackFirmId = firmId;
              }
              return firmId;
            });
          if (firmId == null) { sum.rows_skipped++; continue; }
          // Pass coerced numeric (k/m/b-scaled, FX→USD) values so $1.2M lands as
          // 1200000 — not 1.2 — in firm_metrics.value_num.
          const ins = await insertMetricsForRow(env, firmId, projected.fields, projected.numeric, intent, sourceUrl, importedFrom);
          sum.metrics_inserted += ins;
          sum.rows_imported++;
        }
      }
      totalImported += sum.rows_imported;
      totalFirmsCreated += sum.firms_created;
      totalFirmsUpdated += sum.firms_updated;
      totalMetricsInserted += sum.metrics_inserted;
      totalLeadsCreated += sum.leads_created;
      totalLeadsUpdated += sum.leads_updated;
      totalSkipped += sum.rows_skipped;
      summaries.push(sum);
      await persistTabResult(env, tabRow?.id, sum);
    }

    // Enqueue scrape jobs for every extracted URL when toggled on.
    let queuedJobs = 0;
    if (row.scrape_urls) {
      const urlsRaw = await env.SCRAPE_CACHE.get(`upload_urls:${importId}`);
      const urls: string[] = urlsRaw ? (JSON.parse(urlsRaw) as string[]) : [];
      for (const u of urls) {
        const ok = await enqueueScrapeJob(env, u, importId);
        if (ok) queuedJobs += 1;
      }
    }

    // Merge per-tab outcomes back into the parse-time summary so we end up
    // with ONE canonical schema (no separate tabs_outcome/totals object).
    // Required per-tab keys: name, intent, rows_seen, rows_imported,
    // rows_updated, rows_rejected, low_confidence_cells, ocr_disagreements.
    // Required aggregate keys: newFirms, updatedFirms, newCompanies,
    // urlsExtracted, jobsQueued, warnings.
    const existingSummaryRaw = await env.DB.prepare("SELECT summary_json FROM file_imports WHERE id = ?")
      .bind(importId).first<{ summary_json: string | null }>();
    let merged: Record<string, unknown> = {};
    try { if (existingSummaryRaw?.summary_json) merged = JSON.parse(existingSummaryRaw.summary_json) as Record<string, unknown>; } catch { /* ignore */ }
    type ParseTab = { index: number; sheet?: string | null; intent?: string;
      rows_seen?: number; rows_imported?: number; rows_updated?: number;
      rows_rejected?: number; low_confidence_cells?: number; ocr_disagreements?: number };
    const parseTabs: ParseTab[] = Array.isArray(merged.tabs) ? (merged.tabs as ParseTab[]) : [];
    // TabSummary uses `index` (not `tab_index`) — must match the parse-time
    // tabs[].index so per-tab counters land correctly.
    const byIdx = new Map<number, TabSummary>();
    for (const s of summaries) byIdx.set(s.index, s);
    for (const t of parseTabs) {
      const s = byIdx.get(t.index);
      t.rows_imported = s?.rows_imported ?? 0;
      t.rows_updated = (s?.firms_updated ?? 0) + (s?.leads_updated ?? 0);
      t.rows_rejected = s?.rows_skipped ?? 0;
      t.rows_seen = t.rows_seen ?? 0;
      t.low_confidence_cells = t.low_confidence_cells ?? 0;
      t.ocr_disagreements = t.ocr_disagreements ?? 0;
    }
    merged.tabs = parseTabs;
    // Aggregate totals (canonical names per acceptance contract).
    const urlsRaw = await env.SCRAPE_CACHE.get(`upload_urls:${importId}`);
    const urlsExtracted = urlsRaw ? (JSON.parse(urlsRaw) as string[]).length : 0;
    const warnings = summaries.flatMap((s) => s.errors).slice(0, 50);
    merged.newFirms = totalFirmsCreated;
    merged.updatedFirms = totalFirmsUpdated;
    merged.newCompanies = 0;
    merged.urlsExtracted = urlsExtracted;
    merged.jobsQueued = queuedJobs;
    merged.warnings = warnings;
    merged.rows_imported_total = totalImported;
    // Aggregate matches per-tab semantics (firms + leads updates).
    merged.rows_updated_total = totalFirmsUpdated + totalLeadsUpdated;
    merged.rows_rejected_total = totalSkipped;
    merged.metrics_inserted = totalMetricsInserted;
    merged.leads_created = totalLeadsCreated;
    merged.leads_updated = totalLeadsUpdated;

    // Final-boundary cancellation gate: if the operator cancelled this
    // job mid-run (e.g. via /confirm-map?force=1 enqueuing a replacement),
    // do NOT clobber the file_imports row to 'done' — the replacement
    // job is the source of truth. Side-effects already written to the
    // graph are fine (the replacement re-imports idempotently via
    // existing upsert/superseded chains).
    if (opts.jobId) {
      const job = await env.DB
        .prepare("SELECT status FROM jobs WHERE id = ?")
        .bind(opts.jobId)
        .first<{ status: string }>();
      if (job?.status === "cancelled") return;
    }
    const errFlat = summaries.flatMap((s) => s.errors).slice(0, 20).join("; ");
    await env.DB.prepare(
      `UPDATE file_imports
         SET status = 'done',
             rows_imported = ?, firms_created = ?, firms_updated = ?,
             leads_created = ?, leads_updated = ?, queued_jobs = ?,
             summary_json = ?,
             error = CASE WHEN ? = '' THEN NULL ELSE ? END,
             updated_at = ?
       WHERE id = ?`,
    ).bind(
      totalImported, totalFirmsCreated, totalFirmsUpdated,
      totalLeadsCreated, totalLeadsUpdated, queuedJobs,
      JSON.stringify(merged),
      errFlat, errFlat,
      new Date().toISOString(), importId,
    ).run();
  } catch (e) {
    await env.DB.prepare(
      "UPDATE file_imports SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
    ).bind(String((e as Error).message).slice(0, 500), new Date().toISOString(), importId).run();
    throw e;
  }
}

async function persistTabResult(env: Env, tabId: string | undefined, s: TabSummary): Promise<void> {
  if (!tabId) return;
  await env.DB.prepare(
    `UPDATE file_import_tabs SET rows_imported = ?, rows_skipped = ?, error = ? WHERE id = ?`,
  ).bind(s.rows_imported, s.rows_skipped, s.errors.length ? s.errors.slice(0, 5).join("; ").slice(0, 500) : null, tabId).run();
}

function parseMap(raw: string | null): Record<string, MappedField | null> {
  if (!raw) return {};
  let v: Record<string, string>;
  try { v = JSON.parse(raw) as Record<string, string>; } catch { return {}; }
  const out: Record<string, MappedField | null> = {};
  for (const [header, target] of Object.entries(v)) {
    if (!target || target === "__skip__") { out[header] = null; continue; }
    const dot = target.indexOf(".");
    if (dot < 0) { out[header] = null; continue; }
    out[header] = { entity: target.slice(0, dot) as Entity, field: target.slice(dot + 1) };
  }
  return out;
}

interface CoercedRow {
  fields: Record<string, string>;        // canonical strings (post-coerce)
  numeric: Record<string, number>;       // for money/year, in their target units
  iso2List: Record<string, string[]>;    // for multi-country cells
  arrays: Record<string, string[]>;      // for stages/sectors/geo_focus
}

/** Project a raw row through the confirmed map. Returns a thunk that, when
 *  awaited, also fills FX-converted USD numbers (since FX needs network). */
function projectAndCoerceRow(
  raw: Record<string, string>,
  map: Record<string, MappedField | null>,
  env: Env,
): { fields: Record<string, string>; awaited: () => Promise<CoercedRow> } {
  const fields: Record<string, string> = {};
  const numeric: Record<string, number> = {};
  const iso2List: Record<string, string[]> = {};
  const arrays: Record<string, string[]> = {};
  const moneyJobs: Array<{ key: string; raw: string; isMin: boolean; isMax: boolean }> = [];
  for (const [header, value] of Object.entries(raw)) {
    if (isEmptyCell(value)) continue;
    const m = map[header];
    if (!m) continue;
    const f = m.field;
    const v = value.trim();
    // Field-type-specific coercion. When ambiguous we still write the raw
    // string into `fields` so downstream code can re-parse if needed.
    if (/_usd$/.test(f) || /size|amount|aum|raised|exit/.test(f)) {
      // Range-aware: "50-100M EUR" → {min, max, typical_usd}. For min/max
      // fields we pick the appropriate end so check_size_min_usd actually
      // reflects min, not midpoint.
      const isMin = /_min_usd$/.test(f);
      const isMax = /_max_usd$/.test(f);
      const range = parseMoneyRange(v);
      if (range.typical_native != null) {
        moneyJobs.push({ key: f, raw: v, isMin, isMax });
        const native = isMin ? (range.min ?? range.typical_native)
                     : isMax ? (range.max ?? range.typical_native)
                     : range.typical_native;
        if (range.currency === "USD" || !range.currency) numeric[f] = native;
      } else {
        const parsed = parseMoney(v);
        if (parsed.native != null) {
          moneyJobs.push({ key: f, raw: v, isMin: false, isMax: false });
          if (parsed.currency === "USD" || !parsed.currency) numeric[f] = parsed.native;
        }
      }
      fields[f] = v;
    } else if (/year|founded|inception|vintage/.test(f)) {
      const y = parseYear(v);
      if (y != null) { numeric[f] = y; fields[f] = String(y); }
    } else if (f === "stages") {
      arrays[f] = parseStages(v);
      fields[f] = arrays[f].join(", ") || v;
    } else if (f === "sectors" || f === "geo_focus" || f === "notable_investments") {
      const list = v.split(/[,;|]+/).map((x) => x.trim()).filter(Boolean);
      arrays[f] = list;
      fields[f] = list.join(", ");
    } else if (f === "hq_country_iso2") {
      const iso = parseCountryIso2(v);
      if (iso) fields[f] = iso;
      else iso2List[f] = parseCountryIso2List(v);
    } else if (/_url$|website|linkedin|crunchbase|signal_nfx|openvc|submission/.test(f)) {
      const u = parseUrl(v);
      fields[f] = u || v;
    } else if (f === "twitter_handle") {
      fields[f] = v.replace(/^@/, "").replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "");
    } else if (/_count$|portfolio_count|fund_count|team_size/.test(f)) {
      const n = parseInt(v.replace(/[^\d-]/g, ""), 10);
      if (Number.isFinite(n)) { numeric[f] = n; fields[f] = String(n); }
    } else if (/^is_|^has_/.test(f)) {
      const b = parseBool(v);
      if (b != null) fields[f] = b ? "1" : "0";
    } else {
      fields[f] = v;
    }
  }
  return {
    fields,
    awaited: async () => {
      // Walk money jobs and resolve FX → USD. Use range-aware path so
      // "50-100M EUR" lands as a USD value derived from the appropriate
      // endpoint (min/max/typical) for the target field.
      for (const j of moneyJobs) {
        if (numeric[j.key] != null) continue; // already USD
        const r = await parseMoneyRangeUsd(env, j.raw);
        if (r.typical_usd != null) {
          if (j.isMin && r.min != null && r.currency) {
            // Convert min specifically.
            const single = await parseMoneyUsd(env, `${r.min} ${r.currency}`);
            if (single.usd != null) numeric[j.key] = single.usd;
            else numeric[j.key] = r.typical_usd;
          } else if (j.isMax && r.max != null && r.currency) {
            const single = await parseMoneyUsd(env, `${r.max} ${r.currency}`);
            if (single.usd != null) numeric[j.key] = single.usd;
            else numeric[j.key] = r.typical_usd;
          } else {
            numeric[j.key] = r.typical_usd;
          }
        } else {
          const m = await parseMoneyUsd(env, j.raw);
          if (m.usd != null) numeric[j.key] = m.usd;
        }
      }
      return { fields, numeric, iso2List, arrays };
    },
  };
}

interface FirmUpsertResult { action: "created" | "updated" | "unchanged" | "error" | "skip"; firmId: number | null }

async function tryUpsertFirm(
  env: Env,
  coerced: CoercedRow,
  sourceUrl: string,
  importedFrom: string,
): Promise<FirmUpsertResult> {
  const fields = coerced.fields;
  const name = (fields.name ?? "").trim();
  if (!name) return { action: "skip", firmId: null };
  // Task #5: pre-insert safeguard. The legacy multi-format upload path
  // (parse.ts → auto_map.ts → here) can pick the Type/Kind column as
  // `name` when the operator's CSV has no header row, producing rows
  // like name='VC' or name='Nonprofit, Training Program' on the
  // Investors dashboard. Reject before upsertFirm — surfaced as a
  // skip so the per-tab summary increments rows_skipped.
  if (looksLikeTypeString(name)) return { action: "skip", firmId: null };
  // Map projected fields back to a header-form so the existing
  // `rowToCandidate` parser can build a FirmCandidate without us re-doing
  // its scalar/array coercion logic.
  const headerForm: Record<string, string> = { Name: name };
  const passthrough: Array<[string, string]> = [
    ["website", "Website"], ["domain", "Domain"], ["kind", "Type"],
    ["thesis", "Thesis"], ["stages", "Stage"], ["sectors", "Sector"],
    ["geo_focus", "Geography"], ["hq_city", "City"], ["hq_region", "State"],
    ["hq_country_iso2", "Country"], ["check_size_typical_usd", "Check size"],
    ["check_size_min_usd", "Min check"], ["check_size_max_usd", "Max check"],
    ["aum_usd", "AUM"], ["current_fund_size_usd", "Fund size"],
    ["current_fund_name", "Fund name"], ["fund_count", "Fund count"],
    ["portfolio_count", "Portfolio count"], ["notable_investments", "Investments"],
    ["founded_year", "Founded"], ["team_size", "Team size"],
    ["linkedin_url", "LinkedIn"], ["crunchbase_url", "Crunchbase"],
    ["twitter_handle", "Twitter"], ["signal_nfx_url", "Signal NFX"],
    ["openvc_url", "OpenVC"], ["legal_name", "Legal name"],
    ["submission_url", "Submission"], ["contact_email", "Email"],
  ];
  for (const [src, dest] of passthrough) {
    const v = fields[src];
    if (v) headerForm[dest] = v;
  }
  // Use coerced numeric USD values when available (they beat raw strings).
  for (const k of ["aum_usd", "check_size_typical_usd", "check_size_min_usd", "check_size_max_usd", "current_fund_size_usd"]) {
    const n = coerced.numeric[k];
    if (n != null) headerForm[passthroughOf(k)] = String(n);
  }
  if (coerced.numeric.founded_year != null) headerForm.Founded = String(coerced.numeric.founded_year);

  const built = rowToCandidate(headerForm, sourceUrl);
  if (!built) return { action: "skip", firmId: null };
  const candidate: FirmCandidate = built.candidate;
  if (!candidate.website && candidate.domain) candidate.website = `https://${candidate.domain}`;
  if (!candidate.website && !candidate.domain) return { action: "skip", firmId: null };
  try {
    const r = await upsertFirm(env, candidate, importedFrom);
    return { action: r.action, firmId: r.firmId };
  } catch {
    return { action: "error", firmId: null };
  }
}

function passthroughOf(key: string): string {
  const map: Record<string, string> = {
    aum_usd: "AUM", check_size_typical_usd: "Check size", check_size_min_usd: "Min check",
    check_size_max_usd: "Max check", current_fund_size_usd: "Fund size",
  };
  return map[key] ?? key;
}

async function tryInsertLead(
  env: Env,
  fields: Record<string, string>,
  jobId: string,
  importedFrom: string,
  sourceUrl: string,
  insertBuffer: D1PreparedStatement[],
): Promise<"created" | "merged" | "needs_review" | "skip" | "error"> {
  const email = (fields.email ?? "").trim().toLowerCase() || null;
  const name = (fields.name ?? "").trim() || null;
  if (!email && !name) return "skip";
  // Task #5: reject type-string names (see same guard in tryUpsertFirm).
  if (name && looksLikeTypeString(name)) return "skip";
  const dnc = await checkAndScrubDnc(env, {
    email,
    phone: (fields.phone ?? "").trim() || null,
    linkedin_url: (fields.linkedin_url ?? "").trim() || null,
    twitter_url: (fields.twitter_url ?? "").trim() || null,
    github_url: null,
    source_domain: "upload",
  });
  const incoming = {
    email: dnc.cleaned.email, phone: dnc.cleaned.phone,
    linkedin_url: dnc.cleaned.linkedin_url, twitter_url: dnc.cleaned.twitter_url,
    github_url: dnc.cleaned.github_url, personal_url: null,
    name, org: (fields.org ?? "").trim() || null, title: (fields.title ?? "").trim() || null,
    category: null, city: null, source_url: sourceUrl, provider: importedFrom,
  };
  try {
    const decision = await resolveIncoming(env.DB, incoming, { jobId, provider: importedFrom, dncHit: dnc.hit }, env);
    if (decision.action === "merged") return "merged";
    if (decision.action === "needs_review") {
      const match = await findMatch(env.DB, { email: incoming.email, phone: incoming.phone, linkedin_url: incoming.linkedin_url, name: incoming.name, org: incoming.org, city: incoming.city });
      if (match) {
        await mergeIntoExisting(env.DB, match.candidate, incoming, { source: `upload:${importedFrom}`, evidence_url: sourceUrl, changed_by: `import:${jobId}` }, { dncHit: dnc.hit }, env);
        return "merged";
      }
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const keys = buildCanonicalKeys({ email: incoming.email, phone: incoming.phone, linkedin_url: incoming.linkedin_url, name: incoming.name, org: incoming.org, city: incoming.city });
    const lead: Lead = {
      id, name: incoming.name, email: incoming.email, phone: incoming.phone, org: incoming.org, title: incoming.title, category: null,
      source_domain: "upload", source_url: sourceUrl, status: decision.action === "needs_review" ? "needs_review" : "new",
      verified: 0, flagged: 0, approved_at: null, approved_by: null,
      linkedin_url: incoming.linkedin_url, twitter_url: incoming.twitter_url, github_url: null, personal_url: null,
      alt_emails_json: null, bio: null, country_iso2: null, region: null, city: null, timezone: null, tags_json: null,
      provider: importedFrom,
      canonical_email_key: keys.canonical_email_key ?? null, canonical_phone_key: keys.canonical_phone_key ?? null,
      canonical_linkedin_key: keys.canonical_linkedin_key ?? null, canonical_name_firm_key: keys.canonical_name_firm_key ?? null,
      canonical_name_city_key: keys.canonical_name_city_key ?? null, merged_into: null,
      meta_json: JSON.stringify({ import_id: jobId, fetched_from: "upload" }),
      created_at: now, updated_at: now,
    };
    if (dnc.hit) (lead as unknown as Record<string, unknown>).do_not_contact = 1;
    insertBuffer.push(buildLeadInsertStmt(env.DB, lead));
    return "created";
  } catch {
    return "error";
  }
}

/** Resolve a firm id for a metrics row. Tries (in order):
 *  - explicit firms.name+domain on the row → upsert (so cross-firm Stats
 *    tabs still attribute correctly)
 *  - first firm touched by this import (single-firm KPI/geo upload)
 *  - synthesize a firm from the filename (annual-report style)
 */
async function resolveFirmIdForMetric(
  env: Env,
  fields: Record<string, string>,
  touched: Set<number>,
  fallback: number | null,
  filename: string,
  sourceUrl: string,
  importedFrom: string,
): Promise<{ firmId: number | null; created: boolean }> {
  if (fields.name) {
    const r = await tryUpsertFirm(env, { fields, numeric: {}, iso2List: {}, arrays: {} }, sourceUrl, importedFrom);
    return { firmId: r.firmId, created: r.action === "created" };
  }
  if (touched.size) return { firmId: touched.values().next().value as number, created: false };
  if (fallback != null) return { firmId: fallback, created: false };
  const synth = filenameToFirmName(filename);
  if (!synth) return { firmId: null, created: false };
  const r = await tryUpsertFirm(env,
    { fields: { name: synth }, numeric: {}, iso2List: {}, arrays: {} },
    sourceUrl, importedFrom);
  return { firmId: r.firmId, created: r.action === "created" };
}

/** Insert one or more firm_metrics rows for a metrics-tab row. Detects:
 *   - period from a Year/Month/Quarter column in the row
 *   - dimension from a Country/Region/Stage/Sector column
 *   - metric name from the projected field name (deals_count, aum_usd, ...)
 *  Numeric columns each become one firm_metrics row. */
async function insertMetricsForRow(
  env: Env,
  firmId: number,
  fields: Record<string, string>,
  numericOverrides: Record<string, number>,
  intent: TabIntent,
  sourceUrl: string,
  importedFrom: string,
): Promise<number> {
  // Period: explicit firm_metrics.period | founded_year | a "year" substring of any field.
  const period = pickPeriod(fields, intent);
  // Dimension: hq_country_iso2 wins for geo, then sectors[0]/stages[0].
  const dimension = pickDimension(fields, intent);
  let inserted = 0;
  // Time-series schema: keyed on (firm_id, metric_name, metric_date, dimension).
  // metric/period kept populated as legacy aliases for v1 readers.
  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO firm_metrics
      (firm_id, metric_name, metric_date, metric, period, dimension, value_num, value_text, source_url, imported_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stmts: D1PreparedStatement[] = [];
  // Union of fields + numericOverrides keys so coerced-only metrics (e.g.
  // FX-converted aum_usd whose raw was "€1.2M") still get persisted.
  const seenKeys = new Set<string>([...Object.keys(fields), ...Object.keys(numericOverrides)]);
  for (const k of seenKeys) {
    if (k === "period" || k === "dimension" || k === "name" || k === "domain" || k === "website") continue;
    let num: number | null = null;
    if (k in numericOverrides && Number.isFinite(numericOverrides[k])) {
      num = numericOverrides[k];
    } else {
      const raw = fields[k];
      if (raw == null) continue;
      const parsed = parseFloat(String(raw).replace(/[, $€£¥]/g, ""));
      if (Number.isFinite(parsed)) num = parsed;
    }
    if (num == null) continue;
    const metric = canonMetric(k, intent);
    const metricDate = period ?? "YTD";
    stmts.push(stmt.bind(firmId, metric, metricDate, metric, metricDate, dimension, num, String(fields[k] ?? num).slice(0, 200), sourceUrl, importedFrom));
    inserted++;
    if (stmts.length >= 50) {
      try { await env.DB.batch(stmts.splice(0)); } catch { /* ignore */ }
    }
  }
  if (stmts.length) {
    try { await env.DB.batch(stmts); } catch { /* ignore */ }
  }
  return inserted;
}

function pickPeriod(fields: Record<string, string>, intent: TabIntent): string | null {
  const explicit = fields.period;
  if (explicit) return explicit;
  if (fields.founded_year && /^\d{4}$/.test(fields.founded_year)) return fields.founded_year;
  for (const v of Object.values(fields)) {
    const m = /\b((?:19|20)\d{2})(?:[-/]?(?:Q[1-4]|\d{2}))?\b/.exec(String(v));
    if (m) return m[0];
  }
  return intent === "firm_kpi" ? "YTD" : null;
}

function pickDimension(fields: Record<string, string>, intent: TabIntent): string | null {
  if (intent === "firm_geo") return fields.hq_country_iso2 ?? null;
  if (fields.dimension) return fields.dimension;
  return null;
}

function canonMetric(field: string, intent: TabIntent): string {
  if (field === "aum_usd") return "aum_usd";
  if (field.endsWith("_count")) return field;
  if (field.endsWith("_usd")) return field;
  if (field === "geo_pct" || field === "stage_pct" || field === "sector_pct") return field;
  return intent === "firm_geo" ? "geo_pct"
       : intent === "firm_kpi" ? `kpi:${field}`
       : `metric:${field}`;
}

function filenameToFirmName(filename: string): string | null {
  const base = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
  const cleaned = base.replace(/\b(annual report|portfolio|holdings|fy\s?\d{4}|\d{4})\b/gi, "").replace(/\s{2,}/g, " ").trim();
  return cleaned || base || null;
}

function buildLeadInsertStmt(db: D1Database, lead: Lead): D1PreparedStatement {
  const rec = lead as unknown as Record<string, unknown>;
  const cols = Object.keys(rec);
  const placeholders = cols.map(() => "?").join(", ");
  const values = cols.map((c) => rec[c] ?? null);
  return db.prepare(`INSERT INTO leads (${cols.join(", ")}) VALUES (${placeholders})`).bind(...values);
}

async function parseAllTables(bytes: ArrayBuffer, row: FileImportRow, env: Env): Promise<ParsedTable[]> {
  const ext = extOf(row.filename);
  const fmt = (row.format as ReturnType<typeof detectFormat>) || detectFormat({ ext, mime: row.mime });
  // JSON envelope (URL uploads) — same shape as parse.ts decodes.
  if (fmt === "gsheet" || fmt === "airtable" || row.mime === "application/json") {
    const decoded = decodeJsonBlobBytes(bytes);
    if (decoded) return decoded;
  }
  if (fmt === "csv")  return [parseCsv(new TextDecoder().decode(bytes))];
  if (fmt === "tsv")  return [parseCsv(new TextDecoder().decode(bytes), "\t")];
  if (fmt === "xlsx" || fmt === "xls" || fmt === "ods") return parseSpreadsheet(bytes);
  if (fmt === "pdf-text") return parsePdfTables(bytes, env);
  if (fmt === "pdf-image") {
    const v = await extractTablesFromImagePdf(env, bytes);
    return v.length ? v : await parsePdfTables(bytes, env);
  }
  if (fmt === "image") return extractTablesFromImage(env, bytes);
  return parseSpreadsheet(bytes);
}

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : "";
}

function decodeJsonBlobBytes(bytes: ArrayBuffer): ParsedTable[] | null {
  if (bytes.byteLength < 2) return null;
  const u8 = new Uint8Array(bytes);
  let i = 0; while (i < u8.length && (u8[i] === 0xef || u8[i] === 0xbb || u8[i] === 0xbf || u8[i] <= 0x20)) i++;
  if (u8[i] !== 0x7b) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as { tables?: ParsedTable[] };
    return Array.isArray(j?.tables) ? j.tables : null;
  } catch { return null; }
}

// ---- URL → scrape job enqueue (unchanged from v1) ------------------------

async function enqueueScrapeJob(env: Env, url: string, importId: string): Promise<boolean> {
  // Pre-enqueue ToS gate: skip queueing entirely for blocked hosts so the
  // queue stays clean and operators see no spurious jobs in the dashboard.
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (tosBlockedReason(host) !== null) return false;
  } catch { return false; }
  const klass = classifyUrl(url);
  // Single profile URLs route to the "url" dispatcher (processProfileUrl
  // path); only multi-profile pages use "profile_list".
  const kind: JobKind = klass === "firmlist" ? "firmlist" : "url";
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO jobs (id, name, source, status, kind, target, parent_job_id, config_json, started_at, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    ).bind(jobId, `${kind}:${url}`.slice(0, 200), `upload:${importId}`, kind, url, null, JSON.stringify({ from_upload: importId }), now, now).run();
    const msg: JobMessage = { jobId, kind, target: url, config: { from_upload: importId } };
    await env.LEAD_QUEUE.send(msg);
    return true;
  } catch { return false; }
}
