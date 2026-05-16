import { Hono } from "hono";
import type { Env } from "../types";
import {
  upsertSource, updateSource, archiveSource,
  enqueueSourceRun, autodetectImporter, canonicalizeUrl, importerExists,
  type SourceRow,
} from "../sources/registry";
import { loadSeedSources } from "../sources/seed_loader";
import { selectImporter, FIRMLIST_IMPORTERS } from "../scraper/parsers/firmlists";

/**
 * Task #5: Source registry CRUD + run-all + preview + bootstrap.
 *
 * Mounted at `/api/sources/*`. All routes sit behind `accessGuard` and
 * are operator-only.
 */
export const sources = new Hono<{ Bindings: Env; Variables: { email: string } }>();

/** GET /api/sources — filterable list. */
sources.get("/", async (c) => {
  const enabled = c.req.query("enabled");
  const importer = c.req.query("importer");
  const status = c.req.query("status");
  const due = c.req.query("due");
  const category = c.req.query("category");
  const region = c.req.query("region");
  const limit = Math.min(Number(c.req.query("limit") ?? "500"), 1000);

  const where: string[] = [];
  const args: unknown[] = [];
  if (enabled === "1" || enabled === "true") { where.push("enabled = 1"); }
  else if (enabled === "0" || enabled === "false") { where.push("enabled = 0"); }
  if (importer) { where.push("importer = ?"); args.push(importer); }
  if (status) { where.push("last_run_status = ?"); args.push(status); }
  if (category) { where.push("category = ?"); args.push(category); }
  if (region) { where.push("region = ?"); args.push(region); }
  if (due === "1" || due === "true") {
    where.push("enabled = 1 AND (next_run_after IS NULL OR datetime(next_run_after) <= datetime('now'))");
  }
  const sql = `SELECT * FROM source_registry ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY enabled DESC, COALESCE(last_run_at, added_at) DESC LIMIT ?`;
  args.push(limit);
  const r = await c.env.DB.prepare(sql).bind(...args).all<SourceRow>();
  const items = (r.results ?? []).map(rowToJson);

  // Top-stat cards.
  const stats = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
       SUM(CASE WHEN enabled = 1 AND (next_run_after IS NULL OR datetime(next_run_after) <= datetime('now')) THEN 1 ELSE 0 END) AS due,
       SUM(CASE WHEN last_run_status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(records_seen_last) AS records_last,
       SUM(records_created_last) AS created_last
       FROM source_registry`,
  ).first<{ total: number; enabled: number; due: number; failed: number; records_last: number; created_last: number }>();

  return c.json({ items, stats });
});

/** POST /api/sources — create. Auto-detects importer if not supplied. */
sources.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.url !== "string") {
    return c.json({ error: "bad_request", message: "url required" }, 400);
  }
  const email = c.get("email") ?? null;
  const hints = body.hints && typeof body.hints === "object" && !Array.isArray(body.hints)
    ? (body.hints as Record<string, unknown>) : null;
  const r = await upsertSource(c.env, {
    url: body.url,
    importer: typeof body.importer === "string" ? body.importer : null,
    label: typeof body.label === "string" ? body.label : null,
    category: typeof body.category === "string" ? body.category : null,
    region: typeof body.region === "string" ? body.region : null,
    role_hint: typeof body.role_hint === "string" ? body.role_hint : null,
    hints,
    schedule_cron: typeof body.schedule_cron === "string" ? body.schedule_cron : null,
    notes: typeof body.notes === "string" ? body.notes : null,
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    added_by: email,
  });
  if ("error" in r) return c.json({ error: r.error }, 400);
  return c.json({ id: r.id, created: r.created, source: rowToJson(r.row) }, r.created ? 201 : 200);
});

/** GET /api/sources/detect?url=...  — preview the auto-detected importer. */
sources.get("/detect", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "bad_request", message: "url required" }, 400);
  const can = canonicalizeUrl(url);
  if (!can) return c.json({ error: "invalid_url" }, 400);
  const det = autodetectImporter(url);
  return c.json({
    url: can.url,
    url_canonical: can.canonical,
    url_host: can.host,
    importer: det.importer,
    confident: det.confident,
    reason: det.reason,
    available_importers: Object.keys(FIRMLIST_IMPORTERS).sort(),
  });
});

/**
 * POST /api/sources/preview { url, importer? } — runs the importer
 * synchronously for the first 10 rows so the "Add source" modal can
 * show what's in the list before saving. Bounded — we slice the
 * importer's `firms[]` to 10.
 */
sources.post("/preview", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.url !== "string") {
    return c.json({ error: "bad_request", message: "url required" }, 400);
  }
  const url = body.url;
  const importerName = typeof body.importer === "string" && importerExists(body.importer)
    ? body.importer
    : selectImporter(url).name;
  const importer = FIRMLIST_IMPORTERS[importerName];
  if (!importer) return c.json({ error: "unknown_importer" }, 400);
  try {
    const result = await importer(url, c.env, {});
    return c.json({
      importer: importerName,
      total_seen: result.totalSeen ?? result.firms.length,
      firms: result.firms.slice(0, 10).map((f) => ({
        name: f.name, website: f.website ?? f.domain ?? null,
        country: f.hq_country_iso2 ?? null, city: f.hq_city ?? null,
        thesis: f.thesis ?? null,
      })),
      people_count: result.people?.length ?? 0,
      errors: (result.errors ?? []).slice(0, 5),
    });
  } catch (e) {
    return c.json({ error: "importer_failed", message: (e as Error).message }, 502);
  }
});

/** PATCH /api/sources/:id */
sources.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "bad_request" }, 400);
  const ok = await updateSource(c.env, id, {
    importer: typeof body.importer === "string" ? body.importer : undefined,
    label: typeof body.label === "string" || body.label === null ? body.label as string | null : undefined,
    category: typeof body.category === "string" || body.category === null ? body.category as string | null : undefined,
    region: typeof body.region === "string" || body.region === null ? body.region as string | null : undefined,
    role_hint: typeof body.role_hint === "string" || body.role_hint === null ? body.role_hint as string | null : undefined,
    hints: body.hints && typeof body.hints === "object" && !Array.isArray(body.hints) ? body.hints as Record<string, unknown> : undefined,
    schedule_cron: typeof body.schedule_cron === "string" ? body.schedule_cron : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    notes: typeof body.notes === "string" || body.notes === null ? body.notes as string | null : undefined,
  });
  if (!ok) return c.json({ error: "not_found_or_invalid" }, 404);
  return c.json({ ok: true });
});

/** DELETE /api/sources/:id — disable + archive. Run history is preserved. */
sources.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await archiveSource(c.env, id, c.get("email") ?? null);
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

/** POST /api/sources/:id/run — enqueue a manual run. */
sources.post("/:id/run", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(`SELECT * FROM source_registry WHERE id = ?`).bind(id).first<SourceRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const r = await enqueueSourceRun(c.env, row, { trigger: "manual", email: c.get("email") ?? null });
  return c.json({ ok: true, jobId: r.jobId, runId: r.runId });
});

/**
 * POST /api/sources/run-all — enqueue every enabled source that's due.
 * Operator-triggered counterpart to the 6h cron. Throttles when more
 * than N rows are due (default 100) so a single click can't melt the
 * queue.
 */
sources.post("/run-all", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { limit?: number; force?: boolean };
  const cap = Math.min(Math.max(Number(body.limit ?? 100), 1), 500);
  const rowsQ = body.force
    ? c.env.DB.prepare(`SELECT * FROM source_registry WHERE enabled = 1 ORDER BY COALESCE(last_run_at, added_at) ASC LIMIT ?`).bind(cap)
    : c.env.DB.prepare(
        `SELECT * FROM source_registry
          WHERE enabled = 1
            AND (next_run_after IS NULL OR datetime(next_run_after) <= datetime('now'))
            AND last_run_status != 'running'
          ORDER BY COALESCE(next_run_after, added_at) ASC LIMIT ?`,
      ).bind(cap);
  const rows = (await rowsQ.all<SourceRow>()).results ?? [];
  let queued = 0; const skipped: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    try { await enqueueSourceRun(c.env, row, { trigger: "run_all", email: c.get("email") ?? null }); queued += 1; }
    catch (e) { skipped.push({ id: row.id, reason: (e as Error).message }); }
  }
  return c.json({ queued, skipped, throttled: rows.length >= cap });
});

/** GET /api/sources/:id/runs — recent run history. */
sources.get("/:id/runs", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(Number(c.req.query("limit") ?? "30"), 200);
  const r = await c.env.DB.prepare(
    `SELECT id, job_id, status, started_at, finished_at,
            records_seen, records_created, records_updated,
            records_unchanged, records_errors, error_message, trigger
       FROM source_registry_runs
      WHERE source_id = ?
      ORDER BY started_at DESC LIMIT ?`,
  ).bind(id, limit).all();
  return c.json({ items: r.results ?? [] });
});

/** GET /api/sources/:id — single source detail. */
sources.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(`SELECT * FROM source_registry WHERE id = ?`).bind(id).first<SourceRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ source: rowToJson(row) });
});

/**
 * POST /api/sources/bootstrap — load seed-sources.json into the
 * registry. Idempotent; safe to re-run. Triggered by the operator
 * from the dashboard on first deploy.
 */
sources.post("/bootstrap", async (c) => {
  const r = await loadSeedSources(c.env);
  return c.json(r);
});

function rowToJson(r: SourceRow): Record<string, unknown> {
  return {
    id: r.id, url: r.url, url_canonical: r.url_canonical, url_host: r.url_host,
    importer: r.importer,
    hints: r.importer_config_json ? safeJson(r.importer_config_json) : {},
    label: r.label, category: r.category, region: r.region, role_hint: r.role_hint,
    enabled: !!r.enabled, schedule_cron: r.schedule_cron,
    last_run_at: r.last_run_at, last_success_at: r.last_success_at,
    last_run_status: r.last_run_status, last_run_job_id: r.last_run_job_id,
    records_seen_last: r.records_seen_last, records_created_last: r.records_created_last,
    records_updated_last: r.records_updated_last, records_unchanged_last: r.records_unchanged_last,
    records_errors_last: r.records_errors_last,
    total_runs: r.total_runs, total_success: r.total_success, total_failed: r.total_failed,
    consecutive_failures: r.consecutive_failures,
    next_run_after: r.next_run_after, notes: r.notes,
    added_by: r.added_by, added_at: r.added_at, updated_at: r.updated_at,
  };
}

function safeJson(s: string): Record<string, unknown> { try { return JSON.parse(s); } catch { return {}; } }
