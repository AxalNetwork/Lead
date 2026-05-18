// Task #1: SEC EDGAR discovery loop.
//
// Three discovery channels:
//   1. Daily index — https://www.sec.gov/Archives/edgar/daily-index/{yyyy}/QT{q}/form.{yyyymmdd}.idx
//      One per business day. Lists every filing accepted that day, keyed
//      on CIK + form type + accession_no. We walk the last N days and
//      stage each filing's index URL into the smart_frontier.
//
//   2. Full-text search — https://efts.sec.gov/LATEST/search-index?q=…
//      Used to back-fill historical filings for a specific issuer or
//      ticker. Pages through 100 results at a time.
//
//   3. RSS feeds — https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent
//      Real-time stream of newly-accepted filings; useful for the
//      hourly tick to surface very fresh filings without waiting for the
//      next-day daily index.
//
// All channels route through `upsertDiscoveredUrl` + `enqueueFrontier`
// (Task #2's crawler queue), so SEC filings flow through the same
// fetch / archive / extract pipeline as every other source. Politeness
// is handled by the engine's per-host throttle (hostThrottle DO) +
// AxalVCBot UA — we add nothing here.

import type { Env } from "../../types";
import { crawlerFetch } from "../../crawler/fetcher";
import { upsertDiscoveredUrl, enqueueFrontier } from "../../discovery/store.discovery";
import { normalizeAccession, padCik } from "../../crawler/adapters/secEdgar";

const EDGAR_BASE = "https://www.sec.gov";
const EDGAR_FTS  = "https://efts.sec.gov/LATEST/search-index";

// All SEC discovery fetches route through the canonical `crawlerFetch`
// path (apps/worker/src/crawler/fetcher.ts). That wrapper enforces
// every politeness/observability requirement the task spec calls for:
//   • per-host throttle via the hostThrottle DO (caps SEC at <5 rps),
//   • AxalVCBot User-Agent with contact URL (CRAWLER_UA constant),
//   • robots.txt + policy gates (acquireViaThrottle),
//   • tier ladder (direct → browser → distributed retry),
//   • crawler_fetch_log entries for the ops dashboard,
//   • R2 archive of successful HTML (7-day TTL).
// We must NOT use the raw `fetch()` here — that bypasses the engine's
// politeness contract and is explicitly rejected by code review.

const SEC_FORMS_OF_INTEREST = new Set([
  "10-K", "10-Q", "8-K", "S-1", "S-3",
  "13F-HR", "13F-HR/A",
  "SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A",
  "4", "4/A",
  "D", "D/A",
  "ADV", "ADV/A",
  "PF", "PF/A",
]);

function quarterOf(d: Date): number {
  return Math.floor(d.getUTCMonth() / 3) + 1;
}
function yyyymmdd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export interface DiscoveryResult {
  channel: "daily_index" | "fts" | "rss";
  fetched: number;
  staged: number;
  enqueued: number;
  errors: number;
}

interface FilingHit {
  cik: string;
  form_type: string;
  filer_name: string | null;
  filed_at: string | null;
  filing_url: string;
  accession_no: string | null;
}

async function stageFiling(env: Env, hit: FilingHit, source: string): Promise<{ staged: boolean; enqueued: boolean }> {
  // Pre-skip filings we've already parsed (sec_filings.accession_no PK).
  if (hit.accession_no) {
    const existing = await env.DB.prepare(
      `SELECT 1 FROM sec_filings WHERE accession_no = ? AND ingest_status = 'parsed'`,
    ).bind(hit.accession_no).first();
    if (existing) return { staged: false, enqueued: false };
  }

  // Record the filing header (status='pending') so the dashboard can show
  // ingestion lag and the persist layer has a row to update.
  if (hit.accession_no) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO sec_filings
         (accession_no, cik, form_type, filer_name, filed_at, filing_url, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(hit.accession_no, hit.cik, hit.form_type, hit.filer_name, hit.filed_at, hit.filing_url, source).run();
  }

  // Stage into smart_frontier (typed staging) so the drainer pushes it
  // into the crawl_frontier with the right priority + profile_type hint.
  // Skip smart_frontier if it's not available (older deployments) and
  // upsert directly into discovered_urls + crawl_frontier.
  const up = await upsertDiscoveredUrl(env, {
    url: hit.filing_url,
    discoveryMethod: source,
    depth: 1,
    likelyKind: "sec_filing",
    expectedYieldScore: 90,
  });
  if (!up || up.rejected) return { staged: true, enqueued: false };
  const { inserted } = await enqueueFrontier(env, up.id, 90, null);
  return { staged: true, enqueued: inserted };
}

/**
 * Walk the EDGAR daily index for the last `daysBack` business days and
 * stage every filing whose form type is in SEC_FORMS_OF_INTEREST.
 * Idempotent: filings already in sec_filings are skipped.
 *
 * Date semantics: the SEC publishes day N's daily-index file at
 * ~01:00 UTC on day N+1, so "today's" file does not exist yet when the
 * scheduled job typically runs (02:00 UTC). We always walk backwards
 * starting from YESTERDAY (i=1) so the authoritative pass targets a
 * complete, published index. `daysBack=1` => yesterday; `daysBack=7`
 * => the last seven business days.
 */
export async function walkDailyIndex(env: Env, daysBack = 1, limit = 5000): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { channel: "daily_index", fetched: 0, staged: 0, enqueued: 0, errors: 0 };
  const today = new Date();
  for (let i = 1; i <= daysBack; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // SEC daily index is business days only
    const year = d.getUTCFullYear();
    const q = quarterOf(d);
    const url = `${EDGAR_BASE}/Archives/edgar/daily-index/${year}/QTR${q}/form.${yyyymmdd(d)}.idx`;
    try {
      const res = await crawlerFetch(env, url);
      if (!res.ok) { out.errors++; continue; }
      const txt = res.html;
      out.fetched++;
      // The .idx is a fixed-width text file. After a 7-line header,
      // each row is:
      //   Form Type   Company Name                    CIK    Date Filed   Filename
      const lines = txt.split("\n").slice(7);
      let staged = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        // Whitespace columns; the filename token is the last whitespace-separated chunk.
        const formType = line.slice(0, 12).trim();
        if (!SEC_FORMS_OF_INTEREST.has(formType)) continue;
        const filerName = line.slice(12, 74).trim();
        const cikRaw   = line.slice(74, 86).trim();
        const filedAt  = line.slice(86, 98).trim();
        const filename = line.slice(98).trim();
        if (!filename) continue;
        const cik = padCik(cikRaw);
        if (!cik) continue;
        const filing_url = `${EDGAR_BASE}/${filename.replace(/^\/+/, "")}`;
        const accession_no = normalizeAccession(filename.match(/(\d{10}-?\d{2}-?\d{6})/)?.[1]);
        const hit: FilingHit = { cik, form_type: formType, filer_name: filerName, filed_at: filedAt, filing_url, accession_no };
        const r = await stageFiling(env, hit, "edgar_daily_index");
        if (r.staged) out.staged++;
        if (r.enqueued) out.enqueued++;
        staged++;
        if (staged >= limit) break;
      }
    } catch (e) {
      out.errors++;
      console.warn("walkDailyIndex day failed", url, (e as Error).message);
    }
  }
  return out;
}

/**
 * EDGAR full-text search for a specific query (e.g. CIK, company name,
 * keyword). Useful for back-filling history for a single target.
 *
 * Pages through up to `maxPages` × 100 results.
 */
export async function searchEdgar(
  env: Env,
  q: string,
  opts?: { forms?: string[]; startDate?: string; endDate?: string; maxPages?: number },
): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { channel: "fts", fetched: 0, staged: 0, enqueued: 0, errors: 0 };
  const maxPages = opts?.maxPages ?? 10;
  const formsParam = opts?.forms?.length ? `&forms=${opts.forms.join(",")}` : "";
  const dateParam = opts?.startDate && opts?.endDate
    ? `&dateRange=custom&startdt=${opts.startDate}&enddt=${opts.endDate}` : "";
  for (let page = 0; page < maxPages; page++) {
    const url = `${EDGAR_FTS}?q=${encodeURIComponent(q)}${formsParam}${dateParam}&from=${page * 100}`;
    try {
      const res = await crawlerFetch(env, url);
      if (!res.ok || !res.html) { out.errors++; break; }
      // efts.sec.gov returns JSON in the response body — the crawler
      // tier-0 fetch is content-agnostic, so we JSON.parse manually.
      const j = JSON.parse(res.html) as { hits?: { hits?: Array<{ _source?: Record<string, unknown>; _id?: string }> } };
      out.fetched++;
      const hits = j.hits?.hits ?? [];
      if (hits.length === 0) break;
      for (const h of hits) {
        const src = h._source ?? {};
        const accession_no = normalizeAccession(String(src.adsh ?? h._id ?? ""));
        const cik = padCik(String(((src.ciks as string[] | undefined)?.[0]) ?? ""));
        const formType = String(src.form ?? "").trim();
        const filerName = String(((src.display_names as string[] | undefined)?.[0]) ?? "").trim() || null;
        const filedAt = String(src.file_date ?? "").trim();
        if (!accession_no || !cik || !formType) continue;
        const accNoDash = accession_no.replace(/-/g, "");
        const filing_url = `${EDGAR_BASE}/Archives/edgar/data/${parseInt(cik, 10)}/${accNoDash}/${accession_no}-index.htm`;
        const r = await stageFiling(env, { cik, form_type: formType, filer_name: filerName, filed_at: filedAt, filing_url, accession_no }, "edgar_fts");
        if (r.staged) out.staged++;
        if (r.enqueued) out.enqueued++;
      }
      if (hits.length < 100) break;
    } catch (e) {
      out.errors++;
      console.warn("searchEdgar page failed", page, (e as Error).message);
      break;
    }
  }
  return out;
}

/**
 * EDGAR "current" RSS feed — newly-accepted filings.
 * Used for the hourly tick.
 */
export async function pollEdgarRss(env: Env, formType?: string): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { channel: "rss", fetched: 0, staged: 0, enqueued: 0, errors: 0 };
  const url = `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=${formType ? encodeURIComponent(formType) : ""}&company=&dateb=&owner=include&count=40&output=atom`;
  try {
    const res = await crawlerFetch(env, url);
    if (!res.ok) { out.errors++; return out; }
    const xml = res.html;
    out.fetched++;
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(xml))) {
      const block = m[1];
      const link = block.match(/<link\s+[^>]*href="([^"]+)"/)?.[1];
      const titleRaw = block.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
      const updated = block.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? null;
      if (!link) continue;
      const accession_no = normalizeAccession(link.match(/(\d{10}-?\d{2}-?\d{6})/)?.[1]);
      const cikMatch = link.match(/data\/(\d+)\//);
      const cik = padCik(cikMatch?.[1]);
      if (!accession_no || !cik) continue;
      // Title format: "FORM - Company Name (CIK) (Filer)"
      const tm = /^([^\-]+?)\s*-\s*(.+?)\s*\(\d{1,10}\)/.exec(titleRaw);
      const formType = tm ? tm[1].trim() : "UNKNOWN";
      const filerName = tm ? tm[2].trim() : null;
      const r = await stageFiling(env, {
        cik, form_type: formType, filer_name: filerName,
        filed_at: updated ? updated.slice(0, 10) : null,
        filing_url: link, accession_no,
      }, "edgar_rss");
      if (r.staged) out.staged++;
      if (r.enqueued) out.enqueued++;
    }
  } catch (e) {
    out.errors++;
    console.warn("pollEdgarRss failed", (e as Error).message);
  }
  return out;
}

/**
 * Browse the EDGAR company-browse endpoint for every filing of a given
 * form type accepted in the last N days. Used to backfill new RIAs
 * (Form ADV) and new private companies (Form D) that haven't yet
 * appeared on the daily-index walker because the discovery cadence
 * missed them.
 *
 * URL pattern:
 *   /cgi-bin/browse-edgar?action=getcompany&type={form}&dateb=&action=getcompany&output=atom&count=100
 */
export async function browseEdgarByForm(env: Env, formType: string, count = 100): Promise<DiscoveryResult> {
  const out: DiscoveryResult = { channel: "rss", fetched: 0, staged: 0, enqueued: 0, errors: 0 };
  const url = `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany&type=${encodeURIComponent(formType)}&dateb=&owner=include&count=${count}&output=atom`;
  try {
    const res = await crawlerFetch(env, url);
    if (!res.ok) { out.errors++; return out; }
    const xml = res.html;
    out.fetched++;
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(xml))) {
      const block = m[1];
      const link = block.match(/<link\s+[^>]*href="([^"]+)"/)?.[1];
      const titleRaw = block.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
      const updated = block.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? null;
      if (!link) continue;
      const accession_no = normalizeAccession(link.match(/(\d{10}-?\d{2}-?\d{6})/)?.[1]);
      const cikMatch = link.match(/data\/(\d+)\//);
      const cik = padCik(cikMatch?.[1]);
      if (!accession_no || !cik) continue;
      const tm = /^([^\-]+?)\s*-\s*(.+?)\s*\(\d{1,10}\)/.exec(titleRaw);
      const detectedForm = tm ? tm[1].trim() : formType;
      const filerName = tm ? tm[2].trim() : null;
      const r = await stageFiling(env, {
        cik, form_type: detectedForm, filer_name: filerName,
        filed_at: updated ? updated.slice(0, 10) : null,
        filing_url: link, accession_no,
      }, "edgar_browse");
      if (r.staged) out.staged++;
      if (r.enqueued) out.enqueued++;
    }
  } catch (e) {
    out.errors++;
    console.warn("browseEdgarByForm failed", formType, (e as Error).message);
  }
  return out;
}

/**
 * Discovery cadence (called from scheduled.ts hourly cron):
 *   • Every hour: poll the EDGAR "current" RSS feed for the freshest filings.
 *   • 02 UTC: walk yesterday's daily-index (the authoritative pass; the SEC
 *     publishes day N's index at ~01 UTC on day N+1).
 *   • 03 UTC: company-browse backfill for the highest-value form types
 *     (ADV, D, 13F-HR) — catches anything the RSS or daily-index missed.
 *   • 04 UTC: FTS backfill for any tracked-issuer queue (no-op when empty).
 *
 * All channels are idempotent — re-ingest of the same accession_no is a
 * no-op via sec_filings PK.
 */
export async function runEdgarDiscoveryTick(env: Env): Promise<{
  rss: DiscoveryResult;
  daily: DiscoveryResult | null;
  browse: DiscoveryResult[];
  fts: DiscoveryResult | null;
}> {
  const rss = await pollEdgarRss(env);
  const hour = new Date().getUTCHours();
  const daily = hour === 2 ? await walkDailyIndex(env, 1, 5000) : null;
  // 03 UTC: hit the company-browse endpoint for the three highest-yield
  // forms so a daily-index miss doesn't drop a new RIA / private company.
  const browse: DiscoveryResult[] = [];
  if (hour === 3) {
    for (const form of ["ADV", "D", "13F-HR"]) {
      browse.push(await browseEdgarByForm(env, form, 100));
    }
  }
  // 04 UTC: FTS backfill. Operators can stage targeted queries in
  // sec_fts_queue (created elsewhere); the no-table-found case is
  // swallowed so this stays a no-op until the queue lands.
  let fts: DiscoveryResult | null = null;
  if (hour === 4) {
    try {
      const q = await env.DB.prepare(
        `SELECT query, forms FROM sec_fts_queue WHERE status='queued' ORDER BY created_at LIMIT 5`,
      ).all<{ query: string; forms: string | null }>();
      const queries = q.results ?? [];
      if (queries.length > 0) {
        const merged: DiscoveryResult = { channel: "fts", fetched: 0, staged: 0, enqueued: 0, errors: 0 };
        for (const row of queries) {
          const r = await searchEdgar(env, row.query, {
            forms: row.forms ? row.forms.split(",").map((s) => s.trim()) : undefined,
            maxPages: 3,
          });
          merged.fetched += r.fetched;
          merged.staged += r.staged;
          merged.enqueued += r.enqueued;
          merged.errors += r.errors;
          await env.DB.prepare(
            `UPDATE sec_fts_queue SET status='done', completed_at=CURRENT_TIMESTAMP WHERE query=?`,
          ).bind(row.query).run().catch(() => undefined);
        }
        fts = merged;
      }
    } catch {
      // sec_fts_queue table doesn't exist yet — no-op.
    }
  }
  return { rss, daily, browse, fts };
}
