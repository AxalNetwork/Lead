import { Hono } from "hono";
import type { Env, JobMessage } from "../types";
import { tosBlockedReason } from "../scraper/tos";
import { selectImporter, FIRMLIST_IMPORTERS } from "../scraper/parsers/firmlists";
import { upsertFirm } from "../scraper/firms_upsert";
import type { FirmCandidate } from "../scraper/parsers/firmlists/types";
import { rowToCandidate } from "../scraper/parsers/firmlists/_helpers";

export const imports = new Hono<{ Bindings: Env; Variables: { email: string } }>();

interface FirmlistsBody {
  urls?: unknown;
  importer?: unknown;
  name?: unknown;
}

/**
 * POST /api/import/firmlists
 *   { urls: ["https://...", ...], importer?: "mercury"|"openvc"|... }
 *
 * Enqueues one `firmlist` job per URL. Each job is processed by
 * `processFirmlist` in the pipeline (per-source importer → upsertFirm →
 * child `firm_team_crawl` jobs).
 */
imports.post("/firmlists", async (c) => {
  const body = (await c.req.json().catch(() => null)) as FirmlistsBody | null;
  if (!body || !Array.isArray(body.urls) || !body.urls.length) {
    return c.json({ error: "bad_request", message: "urls[] required" }, 400);
  }
  const importerHint = typeof body.importer === "string" && body.importer in FIRMLIST_IMPORTERS
    ? body.importer
    : null;
  const urls = body.urls
    .filter((u): u is string => typeof u === "string" && !!u.trim())
    .slice(0, 50);

  const results: Array<{ url: string; jobId?: string; importer?: string; error?: string }> = [];
  for (const rawUrl of urls) {
    const url = rawUrl.trim();
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); }
    catch { results.push({ url, error: "invalid_url" }); continue; }
    const tos = tosBlockedReason(host);
    if (tos) { results.push({ url, error: `tos_blocked:${tos}` }); continue; }

    const picked = importerHint
      ? { name: importerHint, importer: FIRMLIST_IMPORTERS[importerHint] }
      : selectImporter(url);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const config = { importer: picked.name };
    const name = `firmlist:${picked.name}:${host}`;
    await c.env.DB.prepare(
      `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
       VALUES (?, ?, ?, 'queued', 'firmlist', ?, ?, ?, ?)`,
    ).bind(id, name, host, url, JSON.stringify(config), now, now).run();

    const msg: JobMessage = { jobId: id, kind: "firmlist", target: url, config };
    await c.env.LEAD_QUEUE.send(msg);
    results.push({ url, jobId: id, importer: picked.name });
  }
  return c.json({ enqueued: results.filter((r) => r.jobId).length, results }, 201);
});

interface NfxPasteBody {
  rows?: unknown;
  source_url?: unknown;
}

/**
 * POST /api/import/nfx/paste  (alias: POST /api/import/nfx-paste)
 *   { rows: [{name, url|profile_url, website|firm, ...}, ...],
 *     source_url?: "https://signal.nfx.com/..." }
 *
 * Manual paste path for NFX Signal (login-gated, can't be scraped).
 * Per the Task #3 spec the alias path accepts `{name, profile_url, firm}[]`
 * — `profile_url` maps to `signal_nfx_url`, `firm` maps to `website` or a
 * `notes:firm=...` line when no URL is present. Each row is upserted with
 * `source='manual_paste'` + `source_kind='manual'` so the dual-write path
 * records the provenance correctly. No scraping is attempted behind the
 * NFX login.
 */
async function nfxPasteHandler(c: import("hono").Context<{ Bindings: Env; Variables: { email: string } }>) {
  const body = (await c.req.json().catch(() => null)) as NfxPasteBody | null;
  if (!body || !Array.isArray(body.rows) || !body.rows.length) {
    return c.json({ error: "bad_request", message: "rows[] required" }, 400);
  }
  const sourceUrl = typeof body.source_url === "string" ? body.source_url : "https://signal.nfx.com/";
  const importedFrom = "manual_paste";
  let created = 0, updated = 0, unchanged = 0;
  const errors: string[] = [];
  for (const raw of body.rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    // Accept all of {url, profile_url, signal_nfx_url, website, firm}.
    const profileUrl = typeof row.profile_url === "string"
      ? row.profile_url
      : typeof row.url === "string"
        ? row.url
        : typeof row.signal_nfx_url === "string"
          ? row.signal_nfx_url
          : null;
    if (typeof row.firm === "string" && !row.website && /^https?:\/\//i.test(row.firm)) row.website = row.firm;
    if (profileUrl && !row.signal_nfx_url) row.signal_nfx_url = profileUrl;
    const cand = rowToCandidate(row, profileUrl ?? sourceUrl);
    if (!cand) { errors.push("missing_name"); continue; }
    const candidate: FirmCandidate = cand.candidate;
    if (typeof row.firm === "string" && !/^https?:\/\//i.test(row.firm)) {
      candidate.notes = candidate.notes ? `${candidate.notes}\nfirm: ${row.firm}` : `firm: ${row.firm}`;
    }
    if (!candidate.signal_nfx_url && profileUrl) candidate.signal_nfx_url = profileUrl;
    // upsertFirm requires either a domain or a website. Manual-paste
    // rows often have only a profile URL + firm name; synthesize a
    // stable placeholder domain (nfx-paste.invalid/{slug}) so the
    // upsert succeeds and dedupe still groups repeat pastes by name.
    if (!candidate.website && !candidate.domain) {
      const slug = (candidate.name || "row").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "row";
      candidate.website = profileUrl ?? `https://nfx-paste.invalid/${slug}`;
      candidate.domain = "nfx-paste.invalid";
    }
    try {
      const r = await upsertFirm(c.env, candidate, importedFrom, { source: "manual_paste", sourceKind: "manual" });
      if (r.action === "created") created += 1;
      else if (r.action === "updated") updated += 1;
      else unchanged += 1;
    } catch (e) {
      errors.push(`${candidate.name}:${(e as Error).message}`);
    }
  }
  return c.json({ created, updated, unchanged, errors: errors.slice(0, 50) });
}

imports.post("/nfx/paste", nfxPasteHandler);
// Task #3: stable alias requested by the spec.
imports.post("/nfx-paste", nfxPasteHandler);

/**
 * GET /api/imports — firmlist parent-job history with per-importer breakdown.
 *
 * Joins each `kind='firmlist'` job to its summary fetch_log row (the one
 * `processFirmlist` writes with `tier=0, status=200, cost_usd=0` and the
 * counts JSON in `block_reason`). Returns:
 *   - items[]: per-job rows {jobId, importer, target, status, total_seen,
 *              created, updated, unchanged, child_jobs, errors[], started_at,
 *              finished_at}
 *   - by_importer{}: rolled-up totals per importer
 *   - totals{}: grand totals across the returned window
 */
imports.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const rows = await c.env.DB.prepare(
    `SELECT j.id, j.name, j.source, j.target, j.status, j.config_json,
            j.leads_found, j.pages_fetched, j.started_at, j.finished_at,
            j.cancelled_at, j.created_at,
            (SELECT block_reason FROM fetch_log
              WHERE job_id = j.id AND tier = 0 AND status = 200
              ORDER BY id DESC LIMIT 1) AS summary_json
       FROM jobs j
      WHERE j.kind = 'firmlist'
      ORDER BY j.started_at DESC
      LIMIT ?`,
  ).bind(limit).all<Record<string, unknown>>();

  const items: Array<Record<string, unknown>> = [];
  const byImporter = new Map<string, { jobs: number; total_seen: number; created: number; updated: number; unchanged: number; child_jobs: number; errors: number }>();
  const totals = { jobs: 0, total_seen: 0, created: 0, updated: 0, unchanged: 0, child_jobs: 0, errors: 0 };

  for (const r of rows.results ?? []) {
    const summary = parseSummary(r.summary_json as string | null);
    const cfg = parseJsonObj(r.config_json as string | null);
    const importer = summary.importer ?? (typeof cfg.importer === "string" ? cfg.importer : "unknown");
    items.push({
      jobId: r.id,
      name: r.name,
      target: r.target,
      source: r.source,
      status: r.status,
      importer,
      total_seen: summary.total_seen,
      created: summary.created,
      updated: summary.updated,
      unchanged: summary.unchanged,
      child_jobs: summary.child_jobs,
      errors: summary.errors,
      leads_found: r.leads_found,
      started_at: r.started_at,
      finished_at: r.finished_at,
      cancelled_at: r.cancelled_at,
    });
    let agg = byImporter.get(importer);
    if (!agg) {
      agg = { jobs: 0, total_seen: 0, created: 0, updated: 0, unchanged: 0, child_jobs: 0, errors: 0 };
      byImporter.set(importer, agg);
    }
    agg.jobs += 1;
    agg.total_seen += summary.total_seen;
    agg.created += summary.created;
    agg.updated += summary.updated;
    agg.unchanged += summary.unchanged;
    agg.child_jobs += summary.child_jobs;
    agg.errors += summary.errors.length;
    totals.jobs += 1;
    totals.total_seen += summary.total_seen;
    totals.created += summary.created;
    totals.updated += summary.updated;
    totals.unchanged += summary.unchanged;
    totals.child_jobs += summary.child_jobs;
    totals.errors += summary.errors.length;
  }
  const by_importer: Record<string, unknown> = {};
  for (const [k, v] of byImporter) by_importer[k] = v;
  return c.json({ items, by_importer, totals });
});

interface ParsedSummary {
  importer: string | null;
  total_seen: number;
  created: number;
  updated: number;
  unchanged: number;
  child_jobs: number;
  errors: string[];
}

function parseSummary(raw: string | null): ParsedSummary {
  const empty: ParsedSummary = { importer: null, total_seen: 0, created: 0, updated: 0, unchanged: 0, child_jobs: 0, errors: [] };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      importer: typeof v.importer === "string" ? v.importer : null,
      total_seen: Number(v.total_seen ?? 0) || 0,
      created: Number(v.created ?? 0) || 0,
      updated: Number(v.updated ?? 0) || 0,
      unchanged: Number(v.unchanged ?? 0) || 0,
      child_jobs: Number(v.child_jobs ?? 0) || 0,
      errors: Array.isArray(v.errors) ? (v.errors as unknown[]).map((e) => String(e)) : [],
    };
  } catch {
    return empty;
  }
}

function parseJsonObj(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}
