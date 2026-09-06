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
import { reconcileToIntent } from "./auto_map";
import { looksLikeTypeString } from "../services/csv/headerDetector";

const BATCH_SIZE = 200;

// Task #63: resumable chunking. D1/KV/R2/queue calls all count toward the
// per-invocation subrequest cap, so each queue invocation processes rows only
// until it has spent ~SUBREQUEST_BUDGET worth of estimated subrequests, then
// checkpoints its cursor and re-enqueues a resume job. Per-intent cost keeps
// the heavy leads path (DNC + resolveIncoming fact chain + match/merge) from
// blowing the budget while the lighter firms path moves more rows per chunk.
const SUBREQUEST_BUDGET = 700;
const ROW_COST = { leads: 14, firms: 6, metrics: 8 } as const;
// A stalled 'importing' row is re-enqueued up to this many times WITHOUT making
// progress before being marked 'error'. Every progress checkpoint resets
// import_attempts to 0, so a healthy large import never trips this.
const MAX_WATCHDOG_RECOVERIES = 5;

interface FileImportRow {
  id: string;
  status: string | null;
  filename: string;
  mime: string | null;
  r2_key: string;
  entity: Entity | null;
  scrape_urls: number;
  format: string | null;
  created_by: string | null;
  import_phase: string | null;
  import_cursor_tab: number | null;
  import_cursor_row: number | null;
  rows_imported: number | null;
  firms_created: number | null;
  firms_updated: number | null;
  leads_created: number | null;
  leads_updated: number | null;
  queued_jobs: number | null;
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

/** Per-tab cumulative counters carried across chunks (persisted to
 *  file_import_tabs so finalize can rebuild the summary from the DB). */
interface TabCum {
  rows_imported: number;
  rows_updated: number;
  rows_skipped: number;
  metrics_inserted: number;
  errors: string[];
}
const ZERO_TAB = { rows_imported: 0, rows_updated: 0, rows_skipped: 0, metrics_inserted: 0 };

type ParseTab = {
  index: number; sheet?: string | null; intent?: string;
  rows_seen?: number; rows_imported?: number; rows_updated?: number;
  rows_rejected?: number; low_confidence_cells?: number; ocr_disagreements?: number;
};

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
    .prepare("SELECT id, status, filename, mime, r2_key, entity, scrape_urls, format, created_by, import_phase, import_cursor_tab, import_cursor_row, rows_imported, firms_created, firms_updated, leads_created, leads_updated, queued_jobs FROM file_imports WHERE id = ?")
    .bind(importId)
    .first<FileImportRow>();
  if (!row) throw new Error(`file_import_not_found:${importId}`);
  // Terminal-state guard: a late-delivered/duplicate resume message (e.g. a
  // watchdog re-enqueue racing a stale original) must NOT flip a finished import
  // back to 'importing' and re-run all chunks. 'done'/'error' are terminal.
  if (row.status === "done" || row.status === "error") return;

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
    // Load per-tab cumulative counters so a resume seeds the in-progress tab
    // and finalize can rebuild the summary purely from the DB.
    const tabCounterRaw = await env.DB
      .prepare("SELECT tab_index, rows_imported, rows_updated, rows_skipped, metrics_inserted FROM file_import_tabs WHERE import_id = ?")
      .bind(importId)
      .all<{ tab_index: number; rows_imported: number; rows_updated: number; rows_skipped: number; metrics_inserted: number }>();
    const tabCounters = new Map<number, typeof ZERO_TAB>();
    for (const r of tabCounterRaw.results ?? []) {
      tabCounters.set(r.tab_index, {
        rows_imported: r.rows_imported | 0, rows_updated: r.rows_updated | 0,
        rows_skipped: r.rows_skipped | 0, metrics_inserted: r.metrics_inserted | 0,
      });
    }

    // Accumulators seeded from the persisted columns so multi-chunk imports
    // keep a single running total across invocations.
    const acc = {
      imported: row.rows_imported ?? 0, firmsC: row.firms_created ?? 0, firmsU: row.firms_updated ?? 0,
      leadsC: row.leads_created ?? 0, leadsU: row.leads_updated ?? 0,
    };
    let accQueued = row.queued_jobs ?? 0;
    const phase0 = (row.import_phase ?? "rows") as string;
    const cursorTab = row.import_cursor_tab ?? 0;
    const cursorRow = row.import_cursor_row ?? 0;

    const firmIdsTouched = new Set<number>();
    /** Firm-id resolved from filename for portfolio/metrics fallback. */
    let fallbackFirmId: number | null = null;
    const insertBuffer: D1PreparedStatement[] = [];
    const flushLeads = async (): Promise<void> => {
      if (insertBuffer.length) await env.DB.batch(insertBuffer.splice(0));
    };
    let spent = 0; // estimated subrequests consumed this invocation

    // Build the running-totals + cursor UPDATE. import_attempts resets to 0 on
    // every progress checkpoint so the watchdog only escalates true no-progress
    // stalls. Returned as a statement so a checkpoint can batch it ATOMICALLY
    // with the per-tab counter UPDATE — a mid-checkpoint isolate kill then can't
    // desync the cursor from the per-tab counters.
    const accStmt = (phase: string, ct: number, cr: number): D1PreparedStatement =>
      env.DB.prepare(
        `UPDATE file_imports
            SET rows_imported = ?, firms_created = ?, firms_updated = ?,
                leads_created = ?, leads_updated = ?, queued_jobs = ?,
                import_phase = ?, import_cursor_tab = ?, import_cursor_row = ?,
                import_attempts = 0, updated_at = ?
          WHERE id = ?`,
      ).bind(
        acc.imported, acc.firmsC, acc.firmsU, acc.leadsC, acc.leadsU, accQueued,
        phase, ct, cr, new Date().toISOString(), importId,
      );

    // Iterate by DB tab_index so per-tab intents/maps route to the right
    // snapshot tab even if an earlier tab is empty. Fail fast if the DB
    // references a tab_index the snapshot doesn't have.
    const dbTabIndices = tabRows.map((r) => r.tab_index).sort((a, b) => a - b);
    const allIndices = dbTabIndices.length
      ? dbTabIndices
      : Array.from(tablesByIdx.keys()).sort((a, b) => a - b);

    if (phase0 === "rows") {
      for (const i of allIndices) {
        if (i < cursorTab) continue; // completed in an earlier chunk
        const t = tablesByIdx.get(i);
        if (!t) {
          // DB has a tab the snapshot doesn't — refuse to misroute silently.
          throw new Error(`tab_snapshot_missing:${i}`);
        }
        const tabRow = tabRows.find((r) => r.tab_index === i);
        const intent: TabIntent = (tabRow?.intent ?? "firms") as TabIntent;
        const subkind = tabRow?.intent_subkind ?? null;
        const columnMap = parseMap(tabRow?.column_map_json ?? null);
        // Resume seeds the in-progress tab from its persisted cumulative row;
        // later tabs start from zero.
        const seed = (i === cursorTab) ? (tabCounters.get(i) ?? ZERO_TAB) : ZERO_TAB;
        const sum: TabCum = {
          rows_imported: seed.rows_imported, rows_updated: seed.rows_updated,
          rows_skipped: seed.rows_skipped, metrics_inserted: seed.metrics_inserted, errors: [],
        };

        if (intent === "discard" || intent === "notes") {
          sum.rows_skipped = t.rows.length;
          await commitTabEnd(env, tabRow?.id, sum, accStmt, i);
          continue;
        }

        const cost = intent === "leads" ? ROW_COST.leads
          : intent === "firms" ? ROW_COST.firms : ROW_COST.metrics;
        const startOff = (i === cursorTab) ? cursorRow : 0;
        for (let off = startOff; off < t.rows.length; off++) {
          // Budget exhausted → checkpoint at the CURRENT (unprocessed) row and
          // hand off a resume job. Flush buffered lead inserts BEFORE
          // persisting the cursor so counters never run ahead of the writes.
          if (spent + cost > SUBREQUEST_BUDGET) {
            await flushLeads();
            const stmts = [tabCumStmt(env, tabRow?.id, sum), accStmt("rows", i, off)]
              .filter((s): s is D1PreparedStatement => s != null);
            await env.DB.batch(stmts);
            await enqueueImportResume(env, importId);
            return;
          }
          const raw = t.rows[off];
          if (intent === "firms") {
            const projected = projectAndCoerceRow(raw, columnMap, env, intent);
            // Force kind=gov_fund when the tab subkind says so.
            if (subkind === "gov_fund" && !projected.fields.kind) projected.fields.kind = "gov_fund";
            const r = await tryUpsertFirm(env, await projected.awaited(), sourceUrl, importedFrom);
            if (r.action === "created") { acc.firmsC++; acc.imported++; sum.rows_imported++; }
            else if (r.action === "updated") { acc.firmsU++; acc.imported++; sum.rows_imported++; sum.rows_updated++; }
            else if (r.action === "skip") sum.rows_skipped++;
            else if (r.action === "error") { sum.rows_skipped++; sum.errors.push(`firm:${(projected.fields.name ?? "?").slice(0, 40)}`); }
            if (r.firmId != null) { firmIdsTouched.add(r.firmId); if (fallbackFirmId == null) fallbackFirmId = r.firmId; }
          } else if (intent === "leads") {
            const projected = projectAndCoerceRow(raw, columnMap, env, intent);
            const fields = (await projected.awaited()).fields;
            const r = await tryInsertLead(env, fields, importId, importedFrom, sourceUrl, insertBuffer);
            if (r === "created") { acc.leadsC++; acc.imported++; sum.rows_imported++; }
            else if (r === "merged") { acc.leadsU++; acc.imported++; sum.rows_imported++; sum.rows_updated++; }
            else if (r === "skip") sum.rows_skipped++;
            else if (r === "error") { sum.rows_skipped++; sum.errors.push(`lead:${(fields.name ?? "?").slice(0, 40)}`); }
            if (insertBuffer.length >= BATCH_SIZE) await flushLeads();
          } else {
            // firm_metrics | firm_kpi | firm_geo. Resolve firm context: explicit
            // `firms.name`/`firms.domain` columns, else firmIdsTouched, else
            // synthesize from filename. Pass coerced numerics so $1.2M lands as
            // 1200000 — not 1.2 — in firm_metrics.value_num.
            const projected = await (projectAndCoerceRow(raw, columnMap, env, intent)).awaited();
            const { firmId, created } = await resolveFirmIdForMetric(
              env, projected.fields, firmIdsTouched, fallbackFirmId, row.filename, sourceUrl, importedFrom);
            if (created) acc.firmsC++;
            if (firmId != null) { firmIdsTouched.add(firmId); if (fallbackFirmId == null) fallbackFirmId = firmId; }
            if (firmId == null) { sum.rows_skipped++; }
            else {
              const ins = await insertMetricsForRow(env, firmId, projected.fields, projected.numeric, intent, sourceUrl, importedFrom);
              sum.metrics_inserted += ins; acc.imported++; sum.rows_imported++;
            }
          }
          spent += cost;
        }
        // Tab finished within budget — flush, then ATOMICALLY persist its
        // cumulative counters AND advance the cursor past it. Doing both in one
        // batch means an isolate kill between them can't leave the tab counted
        // while the cursor still points inside it (which would double-count on
        // resume).
        await flushLeads();
        await commitTabEnd(env, tabRow?.id, sum, accStmt, i);
      }
    }

    // ---- URL-scrape phase. Its own phase so a large URL set can't blow the
    // budget the row work already spent; resumes from the persisted url offset.
    let urlOffset = (phase0 === "urls") ? cursorRow : 0;
    if (row.scrape_urls) {
      const urlsRaw = await env.SCRAPE_CACHE.get(`upload_urls:${importId}`);
      const urls: string[] = urlsRaw ? (JSON.parse(urlsRaw) as string[]) : [];
      for (; urlOffset < urls.length; urlOffset++) {
        if (spent + 2 > SUBREQUEST_BUDGET) {
          await accStmt("urls", 0, urlOffset).run();
          await enqueueImportResume(env, importId);
          return;
        }
        const ok = await enqueueScrapeJob(env, urls[urlOffset], importId);
        if (ok) accQueued++;
        spent += 2;
      }
    }

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
    await finalizeImport(env, importId, acc, accQueued);
  } catch (e) {
    await env.DB.prepare(
      "UPDATE file_imports SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
    ).bind(String((e as Error).message).slice(0, 500), new Date().toISOString(), importId).run();
    throw e;
  }
}

/** Build a tab's CUMULATIVE-counter UPDATE (across chunks). error uses
 *  COALESCE(NULLIF(...)) so a later no-error chunk doesn't wipe an earlier
 *  chunk's recorded errors. Returns null when there is no tab row id. */
function tabCumStmt(env: Env, tabId: string | undefined, s: TabCum): D1PreparedStatement | null {
  if (!tabId) return null;
  const errStr = s.errors.length ? s.errors.slice(0, 5).join("; ").slice(0, 500) : "";
  return env.DB.prepare(
    `UPDATE file_import_tabs
        SET rows_imported = ?, rows_updated = ?, rows_skipped = ?, metrics_inserted = ?,
            error = COALESCE(NULLIF(?, ''), error)
      WHERE id = ?`,
  ).bind(s.rows_imported, s.rows_updated, s.rows_skipped, s.metrics_inserted, errStr, tabId);
}

/** Commit a finished tab: write its cumulative counters AND advance the cursor
 *  past it (to the next tab, row 0) in ONE atomic D1 batch. `accStmt` carries
 *  the live top-level accumulators, so totals + cursor + per-tab counters all
 *  move together — an isolate kill mid-commit can never desync them. */
async function commitTabEnd(
  env: Env,
  tabId: string | undefined,
  s: TabCum,
  accStmt: (phase: string, ct: number, cr: number) => D1PreparedStatement,
  tabIndex: number,
): Promise<void> {
  const stmts = [tabCumStmt(env, tabId, s), accStmt("rows", tabIndex + 1, 0)]
    .filter((stmt): stmt is D1PreparedStatement => stmt != null);
  await env.DB.batch(stmts);
}

/** Re-enqueue an import_file job to resume a chunked import from its persisted
 *  cursor. The jobs row is inserted 'queued' BEFORE the queue send; if the send
 *  fails we immediately mark that orphan job 'failed' so sweepStuckImports does
 *  NOT mistake it for an in-flight chunk (which would deadlock the import in
 *  'importing' forever). On a clean failure the watchdog re-enqueues next sweep. */
async function enqueueImportResume(env: Env, importId: string): Promise<void> {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
       VALUES (?, ?, ?, 'queued', 'import_file', ?, ?, ?, ?)`,
    ).bind(jobId, `import_file:resume:${importId}`, "upload", importId, JSON.stringify({ importId, resume: true }), now, now).run();
  } catch (e) {
    console.warn("enqueueImportResume insert failed", importId, (e as Error).message);
    return; // no orphan row created; watchdog recovers later
  }
  try {
    const msg: JobMessage = { jobId, kind: "import_file", target: importId, config: { importId, resume: true } };
    await env.LEAD_QUEUE.send(msg);
  } catch (e) {
    console.warn("enqueueImportResume send failed", importId, (e as Error).message);
    // Demote the never-delivered job so the watchdog's active-job check skips it.
    await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'queued'",
    ).bind("queue_send_failed", now, jobId).run().catch(() => {});
  }
}

/** Finalize a completed import: rebuild summary_json purely from the per-tab DB
 *  rows (so it is correct no matter how many chunks contributed), set the
 *  canonical aggregate totals from the persisted accumulators, and flip the row
 *  to 'done' while clearing the resume cursor. */
async function finalizeImport(
  env: Env, importId: string,
  acc: { imported: number; firmsC: number; firmsU: number; leadsC: number; leadsU: number },
  accQueued: number,
): Promise<void> {
  const tabAggRaw = await env.DB
    .prepare("SELECT tab_index, rows_imported, rows_updated, rows_skipped, metrics_inserted, error FROM file_import_tabs WHERE import_id = ?")
    .bind(importId)
    .all<{ tab_index: number; rows_imported: number; rows_updated: number; rows_skipped: number; metrics_inserted: number; error: string | null }>();
  const tabAgg = tabAggRaw.results ?? [];
  let totalSkipped = 0, totalMetrics = 0;
  const byIdx = new Map<number, { rows_imported: number; rows_updated: number; rows_skipped: number }>();
  const warnings: string[] = [];
  for (const t of tabAgg) {
    totalSkipped += t.rows_skipped | 0;
    totalMetrics += t.metrics_inserted | 0;
    byIdx.set(t.tab_index, { rows_imported: t.rows_imported | 0, rows_updated: t.rows_updated | 0, rows_skipped: t.rows_skipped | 0 });
    if (t.error) warnings.push(String(t.error));
  }

  const existingSummaryRaw = await env.DB.prepare("SELECT summary_json FROM file_imports WHERE id = ?")
    .bind(importId).first<{ summary_json: string | null }>();
  let merged: Record<string, unknown> = {};
  try { if (existingSummaryRaw?.summary_json) merged = JSON.parse(existingSummaryRaw.summary_json) as Record<string, unknown>; } catch { /* ignore */ }
  const parseTabs: ParseTab[] = Array.isArray(merged.tabs) ? (merged.tabs as ParseTab[]) : [];
  for (const t of parseTabs) {
    const s = byIdx.get(t.index);
    t.rows_imported = s?.rows_imported ?? 0;
    t.rows_updated = s?.rows_updated ?? 0;
    t.rows_rejected = s?.rows_skipped ?? 0;
    t.rows_seen = t.rows_seen ?? 0;
    t.low_confidence_cells = t.low_confidence_cells ?? 0;
    t.ocr_disagreements = t.ocr_disagreements ?? 0;
  }
  merged.tabs = parseTabs;
  const urlsRaw = await env.SCRAPE_CACHE.get(`upload_urls:${importId}`);
  const urlsExtracted = urlsRaw ? (JSON.parse(urlsRaw) as string[]).length : 0;
  merged.newFirms = acc.firmsC;
  merged.updatedFirms = acc.firmsU;
  merged.newCompanies = 0;
  merged.urlsExtracted = urlsExtracted;
  merged.jobsQueued = accQueued;
  merged.warnings = warnings.slice(0, 50);
  merged.rows_imported_total = acc.imported;
  merged.rows_updated_total = acc.firmsU + acc.leadsU;
  merged.rows_rejected_total = totalSkipped;
  merged.metrics_inserted = totalMetrics;
  merged.leads_created = acc.leadsC;
  merged.leads_updated = acc.leadsU;

  const errFlat = warnings.slice(0, 20).join("; ");
  await env.DB.prepare(
    `UPDATE file_imports
       SET status = 'done',
           rows_imported = ?, firms_created = ?, firms_updated = ?,
           leads_created = ?, leads_updated = ?, queued_jobs = ?,
           summary_json = ?,
           error = CASE WHEN ? = '' THEN NULL ELSE ? END,
           import_phase = 'done', import_cursor_tab = 0, import_cursor_row = 0,
           import_attempts = 0, updated_at = ?
     WHERE id = ?`,
  ).bind(
    acc.imported, acc.firmsC, acc.firmsU, acc.leadsC, acc.leadsU, accQueued,
    JSON.stringify(merged), errFlat, errFlat, new Date().toISOString(), importId,
  ).run();
}

/** Task #63 watchdog: recover legacy file imports stuck in 'importing'. A row
 *  is "stuck" when status='importing', it hasn't been touched in >10 min, and
 *  no import_file job is queued/running for it (so no chunk is in flight).
 *  Re-enqueue a resume job (which continues from the persisted cursor); after
 *  MAX_WATCHDOG_RECOVERIES with no progress (import_attempts is reset to 0 by
 *  every successful chunk checkpoint) give up and mark the row 'error'. */
export async function sweepStuckImports(env: Env): Promise<{ resumed: number; failed: number }> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const rows = await env.DB
    .prepare("SELECT id, import_attempts FROM file_imports WHERE status = 'importing' AND updated_at < ?")
    .bind(cutoff)
    .all<{ id: string; import_attempts: number | null }>();
  let resumed = 0, failed = 0;
  for (const r of rows.results ?? []) {
    // Only a RECENT import_file job counts as in-flight. The import row is
    // already >10 min stale (filtered above) and a live chunk refreshes
    // updated_at on every checkpoint, so a queued/running job started before the
    // cutoff is an orphan (e.g. a worker that died between the jobs INSERT and
    // the queue send, leaving a 'queued' row that was never delivered). Treating
    // those as active would deadlock the import in 'importing' forever.
    const active = await env.DB
      .prepare("SELECT 1 FROM jobs WHERE target = ? AND kind = 'import_file' AND status IN ('queued','running') AND started_at >= ? LIMIT 1")
      .bind(r.id, cutoff)
      .first();
    if (active) continue; // a chunk is still in flight
    const now = new Date().toISOString();
    // Demote any stale orphan jobs so they don't linger / re-trip the check.
    await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error = 'import_orphan_stale', finished_at = ? WHERE target = ? AND kind = 'import_file' AND status IN ('queued','running') AND started_at < ?",
    ).bind(now, r.id, cutoff).run().catch(() => {});
    if ((r.import_attempts ?? 0) >= MAX_WATCHDOG_RECOVERIES) {
      await env.DB.prepare(
        "UPDATE file_imports SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'importing'",
      ).bind(`import_stalled: exceeded ${MAX_WATCHDOG_RECOVERIES} recovery attempts`, now, r.id).run();
      failed++;
      continue;
    }
    await env.DB.prepare(
      "UPDATE file_imports SET import_attempts = import_attempts + 1, updated_at = ? WHERE id = ? AND status = 'importing'",
    ).bind(now, r.id).run();
    await enqueueImportResume(env, r.id);
    resumed++;
  }
  return { resumed, failed };
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
  intent: TabIntent,
): { fields: Record<string, string>; awaited: () => Promise<CoercedRow> } {
  const fields: Record<string, string> = {};
  const numeric: Record<string, number> = {};
  const iso2List: Record<string, string[]> = {};
  const arrays: Record<string, string[]> = {};
  const moneyJobs: Array<{ key: string; raw: string; isMin: boolean; isMax: boolean }> = [];
  for (const [header, value] of Object.entries(raw)) {
    if (isEmptyCell(value)) continue;
    const raw_m = map[header];
    if (!raw_m) continue;
    // Honour the entity half of the mapping. Without this a header mapped
    // to firms.name wrote into leads.name on a people tab, which is how a
    // "Company" column became the person's name on every row of a LinkedIn
    // export. reconcileToIntent remaps where the correspondence is
    // unambiguous (a firm's name is the person's employer) and drops
    // otherwise.
    const m = reconcileToIntent(raw_m, intent);
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
  // Split-name exports map to the first_name/last_name pseudo-fields; leads
  // has no such columns, so compose them here. A mapped full name wins.
  const first = (fields.first_name ?? "").trim();
  const last = (fields.last_name ?? "").trim();
  const name = ((fields.name ?? "").trim() || [first, last].filter(Boolean).join(" ").trim()) || null;
  if (!email && !name) return "skip";
  // Task #5: reject type-string names (see same guard in tryUpsertFirm).
  if (name && looksLikeTypeString(name)) return "skip";
  // A connections export's "URL" column is the person's own profile, but a
  // header alone cannot be told apart from a company website — so decide by
  // value. This matters beyond tidiness: linkedin_url feeds
  // canonical_linkedin_key, one of the few dedupe keys such a file supplies,
  // and routing it to personal_url dropped it entirely (personal_url was
  // hardcoded null on `incoming`).
  //
  // Resolved BEFORE the scrub, never after: a rescued URL must be subject to
  // the do-not-contact check like any other channel.
  const personalUrl = (fields.personal_url ?? fields.website ?? "").trim() || null;
  const linkedinFromUrl = personalUrl && /linkedin\.com\/in\//i.test(personalUrl) ? personalUrl : null;

  const dnc = await checkAndScrubDnc(env, {
    email,
    phone: (fields.phone ?? "").trim() || null,
    linkedin_url: ((fields.linkedin_url ?? "").trim() || linkedinFromUrl) || null,
    twitter_url: (fields.twitter_url ?? "").trim() || null,
    github_url: null,
    source_domain: "upload",
  });
  const incoming = {
    email: dnc.cleaned.email, phone: dnc.cleaned.phone,
    linkedin_url: dnc.cleaned.linkedin_url,
    twitter_url: dnc.cleaned.twitter_url,
    github_url: dnc.cleaned.github_url,
    personal_url: linkedinFromUrl ? null : personalUrl,
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
