import type { Env } from "../types";
import { selectImporter, FIRMLIST_IMPORTERS } from "../scraper/parsers/firmlists";
import { tosBlockedReason } from "../scraper/tos";

/**
 * Source registry helpers — Task #5.
 *
 * The registry stores every recurring import URL the operator has
 * registered with the system. A 6h cron picks rows whose
 * `next_run_after` has passed, enqueues firmlist jobs carrying the
 * `source_registry_id`, and the pipeline writes back completion stats.
 *
 * All importer auto-detection delegates to `selectImporter` (which
 * already encodes every URL→importer rule). The operator can override
 * the choice via `PATCH /api/sources/:id { importer }`.
 */

export interface SourceRow {
  id: string;
  url: string;
  url_canonical: string;
  url_host: string;
  importer: string;
  importer_config_json: string | null;
  label: string | null;
  category: string | null;
  region: string | null;
  role_hint: string | null;
  enabled: number;
  schedule_cron: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_run_status: string;
  last_run_job_id: string | null;
  records_seen_last: number;
  records_created_last: number;
  records_updated_last: number;
  records_unchanged_last: number;
  records_errors_last: number;
  total_runs: number;
  total_success: number;
  total_failed: number;
  consecutive_failures: number;
  next_run_after: string | null;
  notes: string | null;
  added_by: string | null;
  added_at: string;
  updated_at: string;
}

export function canonicalizeUrl(raw: string): { url: string; canonical: string; host: string } | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    u.hostname = host;
    // Strip trailing slash + tracking params for the dedupe key.
    const search = new URLSearchParams(u.search);
    for (const k of [...search.keys()]) {
      if (/^utm_|^fbclid$|^gclid$/i.test(k)) search.delete(k);
    }
    const qs = search.toString();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const canonical = `${u.protocol}//${host}${path}${qs ? `?${qs}` : ""}`.toLowerCase();
    return { url: raw.trim(), canonical, host };
  } catch {
    return null;
  }
}

/**
 * Detect the importer to use for a URL. Wraps `selectImporter` so the
 * dashboard and the API share one detection path. Returns the
 * importer module name (e.g. `"wikipedia"`) plus a confidence flag —
 * `"generic_html"` is the fallback when no host-specific importer
 * matched, signalling to the UI that the choice is best-effort.
 */
export function autodetectImporter(url: string): { importer: string; confident: boolean; reason: string } {
  const can = canonicalizeUrl(url);
  if (!can) return { importer: "generic_html", confident: false, reason: "invalid_url" };
  const picked = selectImporter(can.url);
  const confident = picked.name !== "generic_html" && picked.name !== "generic_jsonld";
  return { importer: picked.name, confident, reason: confident ? `host:${can.host}` : "fallback" };
}

export function importerExists(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIRMLIST_IMPORTERS, name);
}

/**
 * Compute the next run timestamp from a cron expression. We only
 * support the small subset of cron strings that seed-sources.json
 * uses: "0 (every-N) * * *" (every N hours), "0 H * * *" (daily at H
 * UTC), or "0 H * * D" (weekly). Anything else falls back to 6h.
 */
export function nextRunAfter(cron: string, from: Date = new Date()): string {
  const next = new Date(from.getTime());
  const m = cron.trim().match(/^(\d+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)$/);
  if (!m) {
    next.setUTCHours(next.getUTCHours() + 6);
    return next.toISOString();
  }
  const [, , hourField] = m;
  // Every-N-hours form (`*/N`).
  const everyN = hourField.match(/^\*\/(\d+)$/);
  if (everyN) {
    const n = Math.max(1, Number(everyN[1]));
    next.setUTCHours(next.getUTCHours() + n);
    return next.toISOString();
  }
  // Plain hour (`3` means 03:UTC daily).
  const hour = Number(hourField);
  if (Number.isFinite(hour)) {
    next.setUTCHours(hour, 0, 0, 0);
    if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  next.setUTCHours(next.getUTCHours() + 6);
  return next.toISOString();
}

/**
 * Exponential backoff for failed sources. 1st failure waits 1h, 2nd
 * 2h, 3rd 4h, capped at 24h.
 */
export function backoffAfter(consecutiveFailures: number, from: Date = new Date()): string {
  const exp = Math.min(24, 2 ** Math.max(0, consecutiveFailures - 1));
  const next = new Date(from.getTime() + exp * 3600 * 1000);
  return next.toISOString();
}

export interface UpsertInput {
  url: string;
  importer?: string | null;
  label?: string | null;
  category?: string | null;
  region?: string | null;
  role_hint?: string | null;
  hints?: Record<string, unknown> | null;
  schedule_cron?: string | null;
  notes?: string | null;
  added_by?: string | null;
  enabled?: boolean;
}

/**
 * Insert-or-noop on `url_canonical`. Returns the row id (existing or
 * freshly created). When `enabled` is omitted on insert, defaults to
 * true. Existing rows are left alone — use `updateSource` to mutate.
 */
export async function upsertSource(env: Env, input: UpsertInput): Promise<{ id: string; created: boolean; row: SourceRow } | { error: string }> {
  const can = canonicalizeUrl(input.url);
  if (!can) return { error: "invalid_url" };
  const tos = tosBlockedReason(can.host);
  if (tos) return { error: `tos_blocked:${tos}` };

  const importerName = input.importer && importerExists(input.importer)
    ? input.importer
    : autodetectImporter(can.url).importer;

  const existing = await env.DB.prepare(
    `SELECT * FROM source_registry WHERE url_canonical = ?`,
  ).bind(can.canonical).first<SourceRow>();
  if (existing) return { id: existing.id, created: false, row: existing };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const schedule = input.schedule_cron ?? "0 */6 * * *";
  const nextRun = nextRunAfter(schedule, new Date(0)); // due immediately on first deploy
  const cfg = input.hints && Object.keys(input.hints).length > 0
    ? JSON.stringify(input.hints)
    : null;

  await env.DB.prepare(
    `INSERT INTO source_registry
       (id, url, url_canonical, url_host, importer, importer_config_json,
        label, category, region, role_hint, enabled, schedule_cron,
        next_run_after, notes, added_by, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    can.url,
    can.canonical,
    can.host,
    importerName,
    cfg,
    input.label ?? null,
    input.category ?? null,
    input.region ?? null,
    input.role_hint ?? null,
    input.enabled === false ? 0 : 1,
    schedule,
    nextRun,
    input.notes ?? null,
    input.added_by ?? null,
    now,
    now,
  ).run();

  const row = await env.DB.prepare(
    `SELECT * FROM source_registry WHERE id = ?`,
  ).bind(id).first<SourceRow>();
  return { id, created: true, row: row! };
}

export interface UpdateInput {
  importer?: string;
  label?: string | null;
  category?: string | null;
  region?: string | null;
  role_hint?: string | null;
  hints?: Record<string, unknown> | null;
  schedule_cron?: string;
  enabled?: boolean;
  notes?: string | null;
}

export async function updateSource(env: Env, id: string, patch: UpdateInput): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.importer !== undefined) {
    if (!importerExists(patch.importer)) return false;
    sets.push("importer = ?"); args.push(patch.importer);
  }
  if (patch.label !== undefined) { sets.push("label = ?"); args.push(patch.label); }
  if (patch.category !== undefined) { sets.push("category = ?"); args.push(patch.category); }
  if (patch.region !== undefined) { sets.push("region = ?"); args.push(patch.region); }
  if (patch.role_hint !== undefined) { sets.push("role_hint = ?"); args.push(patch.role_hint); }
  if (patch.hints !== undefined) {
    sets.push("importer_config_json = ?");
    args.push(patch.hints ? JSON.stringify(patch.hints) : null);
  }
  if (patch.schedule_cron !== undefined) {
    sets.push("schedule_cron = ?"); args.push(patch.schedule_cron);
    sets.push("next_run_after = ?"); args.push(nextRunAfter(patch.schedule_cron));
  }
  if (patch.enabled !== undefined) { sets.push("enabled = ?"); args.push(patch.enabled ? 1 : 0); }
  if (patch.notes !== undefined) { sets.push("notes = ?"); args.push(patch.notes); }
  if (!sets.length) return false;
  sets.push("updated_at = ?"); args.push(new Date().toISOString());
  args.push(id);
  const r = await env.DB.prepare(
    `UPDATE source_registry SET ${sets.join(", ")} WHERE id = ?`,
  ).bind(...args).run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Soft-delete: disable + record a note. We never hard-delete a source
 * because run history references it.
 */
export async function archiveSource(env: Env, id: string, by: string | null): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE source_registry
       SET enabled = 0,
           notes = COALESCE(notes,'') || ?,
           updated_at = ?
     WHERE id = ?`,
  ).bind(`\narchived_by=${by ?? "unknown"} at ${new Date().toISOString()}`, new Date().toISOString(), id).run();
  return (r.meta?.changes ?? 0) > 0;
}

export interface EnqueueOpts {
  trigger?: "cron" | "manual" | "run_all" | "first_deploy";
  email?: string | null;
}

/**
 * Mark a source as running and enqueue a firmlist job. The job
 * config_json carries `{importer, hints, source_registry_id, run_id}`
 * so `processFirmlist` can write back stats on completion.
 */
export async function enqueueSourceRun(env: Env, source: SourceRow, opts: EnqueueOpts = {}): Promise<{ jobId: string; runId: string }> {
  const jobId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const hints = source.importer_config_json ? safeJson(source.importer_config_json) : null;
  const config = {
    importer: source.importer,
    hints: hints ?? {},
    source_registry_id: source.id,
    source_run_id: runId,
    trigger: opts.trigger ?? "manual",
  };

  await env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
     VALUES (?, ?, ?, 'queued', 'firmlist', ?, ?, ?, ?)`,
  ).bind(
    jobId,
    `source_registry:${source.importer}:${source.url_host}`,
    source.url_host,
    source.url,
    JSON.stringify(config),
    now,
    now,
  ).run();

  await env.DB.prepare(
    `INSERT INTO source_registry_runs (id, source_id, job_id, status, started_at, trigger)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).bind(runId, source.id, jobId, now, opts.trigger ?? "manual").run();

  await env.DB.prepare(
    `UPDATE source_registry
        SET last_run_at = ?,
            last_run_status = 'running',
            last_run_job_id = ?,
            total_runs = total_runs + 1,
            updated_at = ?
      WHERE id = ?`,
  ).bind(now, jobId, now, source.id).run();

  await env.LEAD_QUEUE.send({
    jobId,
    kind: "firmlist",
    target: source.url,
    config,
  });
  return { jobId, runId };
}

/**
 * Called by `processFirmlist` once an import finishes. Updates the
 * registry row + run history with success/failure stats and computes
 * the next due time (cron schedule on success, exponential backoff on
 * failure).
 */
export async function recordRunResult(env: Env, source_registry_id: string, source_run_id: string | null, stats: {
  status: "succeeded" | "partial" | "failed";
  records_seen: number;
  records_created: number;
  records_updated: number;
  records_unchanged: number;
  records_errors: number;
  error_message?: string | null;
}): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT id, schedule_cron, consecutive_failures FROM source_registry WHERE id = ?`,
  ).bind(source_registry_id).first<{ id: string; schedule_cron: string; consecutive_failures: number }>();
  if (!row) return;

  const now = new Date().toISOString();
  const isFailure = stats.status === "failed";
  const consecutive = isFailure ? row.consecutive_failures + 1 : 0;
  const nextRun = isFailure
    ? backoffAfter(consecutive)
    : nextRunAfter(row.schedule_cron);

  await env.DB.prepare(
    `UPDATE source_registry
        SET last_run_status = ?,
            last_success_at = CASE WHEN ? = 'succeeded' OR ? = 'partial' THEN ? ELSE last_success_at END,
            records_seen_last = ?, records_created_last = ?,
            records_updated_last = ?, records_unchanged_last = ?,
            records_errors_last = ?,
            total_success = total_success + CASE WHEN ? = 'succeeded' OR ? = 'partial' THEN 1 ELSE 0 END,
            total_failed = total_failed + CASE WHEN ? = 'failed' THEN 1 ELSE 0 END,
            consecutive_failures = ?,
            next_run_after = ?,
            updated_at = ?
      WHERE id = ?`,
  ).bind(
    stats.status,
    stats.status, stats.status, now,
    stats.records_seen, stats.records_created,
    stats.records_updated, stats.records_unchanged,
    stats.records_errors,
    stats.status, stats.status,
    stats.status,
    consecutive,
    nextRun, now,
    source_registry_id,
  ).run();

  if (source_run_id) {
    await env.DB.prepare(
      `UPDATE source_registry_runs
          SET status = ?, finished_at = ?,
              records_seen = ?, records_created = ?,
              records_updated = ?, records_unchanged = ?,
              records_errors = ?, error_message = ?
        WHERE id = ?`,
    ).bind(
      stats.status, now,
      stats.records_seen, stats.records_created,
      stats.records_updated, stats.records_unchanged,
      stats.records_errors,
      stats.error_message ?? null,
      source_run_id,
    ).run();
  }
}

/**
 * Stamp `last_seen_source_at = now` on every entity id in the batch.
 * Called by `processFirmlist` for every firm/person it created or
 * updated during a source-registry-driven run.
 */
export async function stampEntitiesSeen(env: Env, entityIds: Iterable<string>): Promise<number> {
  const ids = [...new Set([...entityIds])].filter((x) => typeof x === "string" && !!x);
  if (!ids.length) return 0;
  const now = new Date().toISOString();
  // Chunk so SQLite param limits never bite.
  let touched = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const placeholders = slice.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `UPDATE u_entities
          SET last_seen_source_at = ?,
              staleness = CASE WHEN staleness = 'likely_dead' THEN NULL ELSE staleness END
        WHERE id IN (${placeholders})`,
    ).bind(now, ...slice).run();
    touched += r.meta?.changes ?? 0;
  }
  return touched;
}

/**
 * Nightly staleness sweep — flags entities not seen on any source for
 * more than 90 days as `staleness='likely_dead'`. Bounded so a single
 * run can't lock the DB.
 */
export async function sweepStaleEntities(env: Env, maxAgeDays = 90, limit = 2000): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE u_entities
        SET staleness = 'likely_dead'
      WHERE id IN (
        SELECT id FROM u_entities
         WHERE staleness IS NULL
           AND last_seen_source_at IS NOT NULL
           AND datetime(last_seen_source_at) < datetime('now', ?)
         LIMIT ?
      )`,
  ).bind(`-${maxAgeDays} days`, limit).run();
  return r.meta?.changes ?? 0;
}

function safeJson(s: string): Record<string, unknown> | null {
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v as Record<string, unknown> : null; }
  catch { return null; }
}
