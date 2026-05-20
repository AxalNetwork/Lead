// Task #27: error log API powering /dashboard/errors/.
//
// Read endpoints:
//   GET  /api/errors            list (filters: kind, code, job_id, host, q, since, limit, resolved)
//   GET  /api/errors/summary    grouped counts by code (window=24h default)
//   GET  /api/errors/timeseries 7-day hourly chart
//   GET  /api/errors/clusters   cluster by (code, host) for triage
//   GET  /api/errors/:id        detail (full context, cause stack)
//   GET  /api/errors/job/:jobId steps + errors for a single job
//
// Write endpoints:
//   POST /api/errors/:id/replay   re-enqueues the failing job for a fresh attempt
//   POST /api/errors/:id/resolve  mark error (and optionally its cluster) as resolved

import { Hono } from "hono";
import type { Env, JobMessage, JobKind } from "../types";

export const errors = new Hono<{ Bindings: Env; Variables: { email: string; request_id: string } }>();

interface ErrorRow {
  id: number;
  occurred_at: string;
  request_id: string | null;
  job_id: string | null;
  step: string | null;
  code: string;
  kind: string;
  status: number;
  retryable: number;
  message: string | null;
  context_json: string | null;
  cause_name: string | null;
  cause_message: string | null;
  cause_stack: string | null;
  url: string | null;
  method: string | null;
  workflow_run_id: string | null;
  host: string | null;
  user_email: string | null;
  retry_count: number | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

function parseContext(row: ErrorRow): Record<string, unknown> | null {
  if (!row.context_json) return null;
  try { return JSON.parse(row.context_json) as Record<string, unknown>; } catch { return null; }
}

errors.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const kind = c.req.query("kind");
  // `code` accepts comma-separated values for true multi-code filtering, e.g.
  // ?code=fetch.http_4xx,fetch.timeout — matched with SQL `IN (?,?,...)`.
  const codeParam = c.req.query("code");
  const codes = codeParam ? codeParam.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const jobId = c.req.query("job_id");
  const host = c.req.query("host");
  const q = c.req.query("q");
  const since = c.req.query("since");
  const resolved = c.req.query("resolved"); // "true" | "false" | undefined (=all)

  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (kind)  { wheres.push("kind = ?");   binds.push(kind); }
  if (codes.length === 1) { wheres.push("code = ?"); binds.push(codes[0]); }
  else if (codes.length > 1) { wheres.push(`code IN (${codes.map(() => "?").join(",")})`); binds.push(...codes); }
  if (jobId) { wheres.push("job_id = ?"); binds.push(jobId); }
  if (host)  { wheres.push("host = ?");   binds.push(host); }
  if (since) { wheres.push("occurred_at >= ?"); binds.push(since); }
  if (resolved === "true") wheres.push("resolved_at IS NOT NULL");
  if (resolved === "false") wheres.push("resolved_at IS NULL");
  if (q)     { wheres.push("(message LIKE ? OR cause_message LIKE ? OR url LIKE ?)"); const like = `%${q}%`; binds.push(like, like, like); }
  const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
  const r = await c.env.DB.prepare(
    `SELECT id, occurred_at, request_id, job_id, step, code, kind, status, retryable, message, context_json,
            url, method, workflow_run_id, host, user_email, retry_count, resolved_at, resolved_by
     FROM error_log ${whereSql} ORDER BY occurred_at DESC LIMIT ?`,
  ).bind(...binds, limit).all<ErrorRow>();
  const items = (r.results ?? []).map((row) => ({
    ...row,
    retryable: !!row.retryable,
    resolved: !!row.resolved_at,
    context: parseContext(row),
  }));
  return c.json({ items });
});

errors.get("/summary", async (c) => {
  const sinceParam = c.req.query("since");
  const since = sinceParam ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const byCode = await c.env.DB.prepare(
    `SELECT code, kind, COUNT(*) AS n, MAX(occurred_at) AS last_at,
            SUM(CASE WHEN retryable=1 THEN 1 ELSE 0 END) AS retryable_n,
            SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open_n
     FROM error_log WHERE occurred_at >= ? GROUP BY code, kind ORDER BY n DESC LIMIT 50`,
  ).bind(since).all();
  const byKind = await c.env.DB.prepare(
    `SELECT kind, COUNT(*) AS n FROM error_log WHERE occurred_at >= ? GROUP BY kind ORDER BY n DESC`,
  ).bind(since).all();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM error_log WHERE occurred_at >= ?`,
  ).bind(since).first<{ n: number }>();
  return c.json({
    since,
    total: total?.n ?? 0,
    by_code: byCode.results ?? [],
    by_kind: byKind.results ?? [],
  });
});

errors.get("/timeseries", async (c) => {
  // 7-day hourly buckets — used by the dashboard chart.
  const days = Math.min(Math.max(Number(c.req.query("days") ?? "7"), 1), 30);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const r = await c.env.DB.prepare(
    `SELECT substr(occurred_at, 1, 13) AS bucket,
            kind,
            COUNT(*) AS n
     FROM error_log
     WHERE occurred_at >= ?
     GROUP BY bucket, kind
     ORDER BY bucket ASC`,
  ).bind(since).all<{ bucket: string; kind: string; n: number }>();
  return c.json({ since, days, points: r.results ?? [] });
});

errors.get("/clusters", async (c) => {
  // Cluster errors by (code, host) — most useful for triage. Window = 7d.
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const r = await c.env.DB.prepare(
    `SELECT code, kind, COALESCE(host, '') AS host, COUNT(*) AS n,
            COUNT(DISTINCT job_id) AS distinct_jobs,
            MIN(occurred_at) AS first_at,
            MAX(occurred_at) AS last_at,
            SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open_n
     FROM error_log
     WHERE occurred_at >= ?
     GROUP BY code, host
     HAVING n >= 1
     ORDER BY open_n DESC, n DESC
     LIMIT 100`,
  ).bind(since).all();
  return c.json({ since, clusters: r.results ?? [] });
});

errors.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    `SELECT * FROM error_log WHERE id = ?`,
  ).bind(id).first<ErrorRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  // Spec: detail drawer shows the last 5 occurrences in the same {code,host}
  // cluster so the operator sees if this error is a one-off or a wave.
  const cluster = await c.env.DB.prepare(
    `SELECT id, occurred_at, job_id, message, retry_count, resolved_at
       FROM error_log
      WHERE code = ? AND COALESCE(host,'') = COALESCE(?,'') AND id != ?
      ORDER BY occurred_at DESC
      LIMIT 5`,
  ).bind(row.code, row.host ?? "", id).all();
  return c.json({
    ...row,
    retryable: !!row.retryable,
    resolved: !!row.resolved_at,
    context: parseContext(row),
    cluster_recent: (cluster.results ?? []).map((r: Record<string, unknown>) => ({
      ...r,
      resolved: !!r["resolved_at"],
    })),
  });
});

errors.get("/job/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = await c.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first();
  if (!job) return c.json({ error: "not_found" }, 404);
  // Task #7: each auxiliary table (workflow_step_log,
  // job_state_transitions, and even error_log in a fresh env) may be
  // absent in some environments and was a primary source of opaque
  // `db_error` rows on this route. Wrap each read individually so a
  // single missing table degrades to an empty list rather than 500-ing
  // the whole endpoint and adding another `db_error` log entry.
  const steps = await c.env.DB.prepare(
    `SELECT * FROM workflow_step_log WHERE job_id = ? ORDER BY started_at ASC LIMIT 500`,
  ).bind(jobId).all().catch(() => ({ results: [] as unknown[] }));
  const errs = await c.env.DB.prepare(
    `SELECT id, occurred_at, step, code, kind, status, message, context_json, host, retry_count, resolved_at
     FROM error_log WHERE job_id = ? ORDER BY occurred_at ASC LIMIT 500`,
  ).bind(jobId).all<ErrorRow>().catch(() => ({ results: [] as ErrorRow[] }));
  const transitions = await c.env.DB.prepare(
    `SELECT * FROM job_state_transitions WHERE job_id = ? ORDER BY changed_at ASC LIMIT 200`,
  ).bind(jobId).all().catch(() => ({ results: [] as unknown[] }));
  return c.json({
    job,
    steps: steps.results ?? [],
    errors: (errs.results ?? []).map((row) => ({ ...row, context: parseContext(row), resolved: !!row.resolved_at })),
    transitions: transitions.results ?? [],
  });
});

errors.post("/:id{[0-9]+}/replay", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(`SELECT * FROM error_log WHERE id = ?`).bind(id).first<ErrorRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!row.job_id) return c.json({ error: "no_job_attached", message: "This error has no job to replay" }, 400);
  const job = await c.env.DB.prepare(
    `SELECT id, name, source, kind, target, config_json FROM jobs WHERE id = ?`,
  ).bind(row.job_id).first<{ id: string; name: string; source: string; kind: JobKind; target: string; config_json: string | null }>();
  if (!job) return c.json({ error: "job_not_found" }, 404);
  const config = job.config_json ? safeParse(job.config_json) : {};
  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at, parent_job_id)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  ).bind(newId, `${job.name} (replay)`, job.source, job.kind, job.target, JSON.stringify(config), now, now, job.id).run();
  await c.env.DB.prepare(
    `INSERT INTO job_state_transitions (job_id, from_state, to_state, reason, changed_by)
     VALUES (?, NULL, 'queued', ?, ?)`,
  ).bind(newId, `replay_of error #${id}`, c.var.email ?? "system").run();
  const msg: JobMessage = { jobId: newId, kind: job.kind, target: job.target, config: config as Record<string, unknown> };
  await c.env.LEAD_QUEUE.send(msg);
  return c.json({ ok: true, replay_job_id: newId, parent_job_id: job.id }, 201);
});

errors.post("/:id{[0-9]+}/resolve", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { cluster?: boolean };
  const row = await c.env.DB.prepare(`SELECT id, code, host FROM error_log WHERE id = ?`).bind(id).first<{ id: number; code: string; host: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const now = new Date().toISOString();
  const who = c.var.email ?? "system";
  if (body.cluster) {
    // Mark all open errors in the same (code, host) cluster as resolved.
    const r = await c.env.DB.prepare(
      `UPDATE error_log SET resolved_at = ?, resolved_by = ?
       WHERE resolved_at IS NULL AND code = ? AND COALESCE(host,'') = COALESCE(?, '')`,
    ).bind(now, who, row.code, row.host).run();
    return c.json({ ok: true, resolved: r.meta?.changes ?? 0, scope: "cluster" });
  }
  await c.env.DB.prepare(
    `UPDATE error_log SET resolved_at = ?, resolved_by = ? WHERE id = ?`,
  ).bind(now, who, id).run();
  return c.json({ ok: true, resolved: 1, scope: "single" });
});

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
