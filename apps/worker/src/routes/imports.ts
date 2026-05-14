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
 * POST /api/import/nfx/paste
 *   { rows: [{name, url, ...}, ...], source_url?: "https://signal.nfx.com/..." }
 *
 * Manual paste path for NFX Signal (login-gated, can't be scraped).
 * Each row is run through the same field mapper used by spreadsheet imports
 * and upserted directly (no async job).
 */
imports.post("/nfx/paste", async (c) => {
  const body = (await c.req.json().catch(() => null)) as NfxPasteBody | null;
  if (!body || !Array.isArray(body.rows) || !body.rows.length) {
    return c.json({ error: "bad_request", message: "rows[] required" }, 400);
  }
  const sourceUrl = typeof body.source_url === "string" ? body.source_url : "https://signal.nfx.com/";
  const importedFrom = "firmlist:nfx_signal";
  let created = 0, updated = 0, unchanged = 0;
  const errors: string[] = [];
  for (const raw of body.rows) {
    if (!raw || typeof raw !== "object") continue;
    // Accept either {name,url,...} (NFX-style) or {Name, Website, ...}.
    const row = raw as Record<string, unknown>;
    if (typeof row.url === "string" && !row.website) row.website = row.url;
    const cand = rowToCandidate(row, sourceUrl);
    if (!cand) { errors.push("missing_name"); continue; }
    const candidate: FirmCandidate = cand.candidate;
    if (!candidate.signal_nfx_url && typeof row.url === "string") candidate.signal_nfx_url = row.url;
    try {
      const r = await upsertFirm(c.env, candidate, importedFrom);
      if (r.action === "created") created += 1;
      else if (r.action === "updated") updated += 1;
      else unchanged += 1;
    } catch (e) {
      errors.push(`${candidate.name}:${(e as Error).message}`);
    }
  }
  return c.json({ created, updated, unchanged, errors: errors.slice(0, 50) });
});

/**
 * GET /api/imports — recent firmlist jobs with summary stats.
 */
imports.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const r = await c.env.DB.prepare(
    `SELECT id, name, source, kind, target, status, leads_found, pages_fetched,
            started_at, finished_at, cancelled_at, created_at, config_json
       FROM jobs
      WHERE kind IN ('firmlist','firm_team_crawl')
      ORDER BY started_at DESC
      LIMIT ?`,
  ).bind(limit).all();
  return c.json({ items: r.results ?? [] });
});
