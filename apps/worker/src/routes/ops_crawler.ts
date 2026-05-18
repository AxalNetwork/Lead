// Task #2: Crawler Operator Console — read aggregates + control plane.
//
// All routes inherit `accessGuard` + `adminOnly` from the parent mount
// (`/api/ops/*`) in index.ts. Every mutating endpoint writes a row to
// `ops_audit` with the actor email so post-hoc forensics are possible.
//
// Reads target the existing telemetry tables — no new write paths are
// introduced here:
//   * fetch_log (015)            — legacy scraper attempts
//   * crawler_fetch_log (341)    — in-house crawler attempts
//   * crawler_host_config (341)  — per-host politeness + quarantine state
//   * smart_frontier (342)       — typed staging queue
//   * crawler_frontier (341)     — Task #2 url-keyed work queue
//   * crawler_seeds (342)        — per-type seeds
//   * ai_cost_daily (150)        — AI spend roll-up
//   * profile_workflow_runs (345)— typed workflow outcomes (used as the
//                                  "adapter scoreboard" since each
//                                  profile-type workflow IS the adapter
//                                  in the per-profile-type model)

import { Hono } from "hono";
import type { Env } from "../types";
import { fetchPage } from "../scraper/fetcher";
import { classifyPage } from "../services/pageClassifier";

type Vars = { email: string; is_admin: boolean };

export const opsCrawlerRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Insert an ops_audit row. Best-effort — never blocks the response. */
async function audit(
  env: Env,
  actor: string,
  action: string,
  target_kind: string | null,
  target_id: string | null,
  payload: unknown,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO ops_audit (actor_email, action, target_kind, target_id, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      actor,
      action,
      target_kind,
      target_id,
      payload === undefined ? null : JSON.stringify(payload),
    ).run();
  } catch (e) {
    console.warn("ops_audit insert failed", (e as Error).message);
  }
}

opsCrawlerRoute.get("/", (c) =>
  c.json({ ok: true, message: "ops crawler", endpoints: [
    "GET /throughput", "GET /hosts", "GET /frontier", "GET /seeds",
    "GET /adapters", "GET /ai-spend", "GET /compliance", "GET /extractions",
    "POST /pause", "POST /resume", "POST /hosts/:host/quarantine",
    "POST /hosts/:host/unquarantine", "POST /hosts/:host/rps",
    "POST /hosts/:host/clear-robots", "POST /recrawl-entity",
    "POST /test-url", "GET /audit",
  ] }),
);

// ------------------------------------------------------------ THROUGHPUT
// 60-minute pages/sec, hourly buckets for last 24h, success vs block mix.
opsCrawlerRoute.get("/throughput", async (c) => {
  const db = c.env.DB;
  const lastHour = await db.prepare(
    `SELECT
        COUNT(*)                                            AS attempts,
        SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END)               AS rate_limited,
        SUM(CASE WHEN block_reason IS NOT NULL THEN 1 ELSE 0 END)   AS blocked,
        COALESCE(SUM(bytes), 0)                             AS bytes,
        COALESCE(AVG(duration_ms), 0)                       AS avg_ms
       FROM fetch_log
       WHERE created_at >= datetime('now','-1 hour')`,
  ).first<{ attempts: number; ok: number; rate_limited: number; blocked: number; bytes: number; avg_ms: number }>();

  const hourly = await db.prepare(
    `SELECT
        strftime('%Y-%m-%dT%H:00:00Z', created_at) AS bucket,
        COUNT(*)                                   AS attempts,
        SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN block_reason IS NOT NULL OR status >= 400 THEN 1 ELSE 0 END) AS blocked
       FROM fetch_log
       WHERE created_at >= datetime('now','-24 hours')
       GROUP BY bucket
       ORDER BY bucket ASC`,
  ).all<{ bucket: string; attempts: number; ok: number; blocked: number }>();

  const inhouseLastHour = await db.prepare(
    `SELECT COUNT(*) AS attempts,
            SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok
       FROM crawler_fetch_log
       WHERE fetched_at >= datetime('now','-1 hour')`,
  ).first<{ attempts: number; ok: number }>();

  const attempts = lastHour?.attempts ?? 0;
  return c.json({
    last_hour: {
      attempts,
      ok: lastHour?.ok ?? 0,
      rate_limited: lastHour?.rate_limited ?? 0,
      blocked: lastHour?.blocked ?? 0,
      bytes: lastHour?.bytes ?? 0,
      avg_ms: Math.round(lastHour?.avg_ms ?? 0),
      pages_per_sec: +(attempts / 3600).toFixed(3),
    },
    inhouse_last_hour: {
      attempts: inhouseLastHour?.attempts ?? 0,
      ok: inhouseLastHour?.ok ?? 0,
    },
    hourly: hourly.results ?? [],
  });
});

// ------------------------------------------------------------ HOST HEALTH
opsCrawlerRoute.get("/hosts", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "200"), 500);
  const cfg = await c.env.DB.prepare(
    `SELECT host, recommended_tier, max_rps, robots_cached_at,
            quarantined_until, quarantined_at, last_success_at,
            last_error, last_tested_at, success_count, failure_count,
            notes, updated_at
       FROM crawler_host_config
       ORDER BY (failure_count * 1.0 / NULLIF(success_count + failure_count, 0)) DESC NULLS LAST,
                failure_count DESC, host ASC
       LIMIT ?`,
  ).bind(limit).all<Record<string, unknown>>();

  // 24h activity from the legacy fetch_log keyed by host.
  const recent = await c.env.DB.prepare(
    `SELECT host,
            COUNT(*) AS attempts_24h,
            SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok_24h,
            SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS r429_24h,
            SUM(CASE WHEN block_reason IS NOT NULL THEN 1 ELSE 0 END) AS blocked_24h,
            MAX(created_at) AS last_attempt_at
       FROM fetch_log
       WHERE created_at >= datetime('now','-24 hours')
       GROUP BY host`,
  ).all<{ host: string; attempts_24h: number; ok_24h: number; r429_24h: number; blocked_24h: number; last_attempt_at: string }>();
  const byHost = new Map((recent.results ?? []).map((r) => [r.host, r]));

  const items = (cfg.results ?? []).map((row) => {
    const r = byHost.get(String(row.host)) ?? { attempts_24h: 0, ok_24h: 0, r429_24h: 0, blocked_24h: 0, last_attempt_at: null };
    const total = (Number(row.success_count) || 0) + (Number(row.failure_count) || 0);
    const successRate = total > 0 ? +((Number(row.success_count) / total) * 100).toFixed(1) : null;
    return { ...row, ...r, success_rate_pct: successRate };
  });
  return c.json({ items });
});

// ------------------------------------------------------------ FRONTIER
opsCrawlerRoute.get("/frontier", async (c) => {
  const db = c.env.DB;
  const smart = await db.prepare(
    `SELECT profile_type_id, status, COUNT(*) AS n
       FROM smart_frontier
       GROUP BY profile_type_id, status`,
  ).all<{ profile_type_id: string | null; status: string; n: number }>();

  const queue = await db.prepare(
    `SELECT status, COUNT(*) AS n
       FROM crawler_frontier
       GROUP BY status`,
  ).all<{ status: string; n: number }>().catch(() => ({ results: [] as Array<{ status: string; n: number }> }));

  const oldest = await db.prepare(
    `SELECT MIN(discovered_at) AS oldest_queued
       FROM smart_frontier WHERE status='queued'`,
  ).first<{ oldest_queued: string | null }>();

  const byReason = await db.prepare(
    `SELECT discovery_reason, COUNT(*) AS n
       FROM smart_frontier WHERE status='queued'
       GROUP BY discovery_reason ORDER BY n DESC LIMIT 20`,
  ).all<{ discovery_reason: string; n: number }>();

  return c.json({
    smart_frontier: smart.results ?? [],
    crawl_frontier: queue.results ?? [],
    oldest_queued: oldest?.oldest_queued ?? null,
    by_reason: byReason.results ?? [],
  });
});

// ------------------------------------------------------------ SEEDS
opsCrawlerRoute.get("/seeds", async (c) => {
  const items = await c.env.DB.prepare(
    `SELECT s.id, s.profile_type_id, t.label AS profile_type_label,
            s.seed_kind, s.value, s.enabled,
            s.last_crawled_at, s.success_count, s.entity_count,
            s.refresh_interval_hours, s.updated_at
       FROM crawler_seeds s
       LEFT JOIN e_types t ON t.id = s.profile_type_id
       ORDER BY s.enabled DESC, s.last_crawled_at ASC NULLS FIRST
       LIMIT 500`,
  ).all<Record<string, unknown>>();
  return c.json({ items: items.results ?? [] });
});

// ------------------------------------------------------------ ADAPTERS
// Per-profile-type workflow scoreboard: pages parsed, parse-success
// rate, AI spend, last drift.
opsCrawlerRoute.get("/adapters", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.profile_type_id,
            t.label AS profile_type_label,
            COUNT(*) AS runs_7d,
            SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN r.status='partial' THEN 1 ELSE 0 END) AS partial,
            SUM(CASE WHEN r.status='failed'  THEN 1 ELSE 0 END) AS failed,
            SUM(r.facts_written)         AS facts_written,
            SUM(r.facts_verified)        AS facts_verified,
            SUM(r.ai_calls)              AS ai_calls,
            SUM(r.actual_cost_usd)       AS cost_usd,
            MAX(r.run_at)                AS last_run_at
       FROM profile_workflow_runs r
       LEFT JOIN e_types t ON t.id = r.profile_type_id
       WHERE r.run_at >= datetime('now','-7 days')
       GROUP BY r.profile_type_id
       ORDER BY runs_7d DESC
       LIMIT 200`,
  ).all<Record<string, number | string>>();
  const items = (rows.results ?? []).map((r) => {
    const runs = Number(r.runs_7d) || 0;
    const ok = Number(r.success) || 0;
    return { ...r, parse_success_pct: runs > 0 ? +((ok / runs) * 100).toFixed(1) : null };
  });
  return c.json({ items });
});

// ------------------------------------------------------------ AI SPEND
opsCrawlerRoute.get("/ai-spend", async (c) => {
  const daily = await c.env.DB.prepare(
    `SELECT day, SUM(cost_usd) AS cost_usd, SUM(neurons) AS neurons, SUM(calls) AS calls
       FROM ai_cost_daily
       WHERE day >= date('now','-14 days')
       GROUP BY day ORDER BY day ASC`,
  ).all<{ day: string; cost_usd: number; neurons: number; calls: number }>();

  const byPurpose = await c.env.DB.prepare(
    `SELECT purpose, SUM(cost_usd) AS cost_usd, SUM(calls) AS calls
       FROM ai_cost_daily
       WHERE day >= date('now','-7 days')
       GROUP BY purpose ORDER BY cost_usd DESC`,
  ).all<{ purpose: string; cost_usd: number; calls: number }>();

  const byType = await c.env.DB.prepare(
    `SELECT r.profile_type_id, t.label AS profile_type_label,
            SUM(r.actual_cost_usd) AS cost_usd, SUM(r.ai_calls) AS ai_calls
       FROM profile_workflow_runs r
       LEFT JOIN e_types t ON t.id = r.profile_type_id
       WHERE r.run_at >= datetime('now','-7 days')
       GROUP BY r.profile_type_id ORDER BY cost_usd DESC LIMIT 50`,
  ).all<Record<string, unknown>>();

  return c.json({
    daily: daily.results ?? [],
    by_purpose: byPurpose.results ?? [],
    by_profile_type: byType.results ?? [],
  });
});

// ------------------------------------------------------------ COMPLIANCE
opsCrawlerRoute.get("/compliance", async (c) => {
  const refusals = await c.env.DB.prepare(
    `SELECT host, block_reason, COUNT(*) AS n, MAX(created_at) AS last_at
       FROM fetch_log
       WHERE created_at >= datetime('now','-24 hours')
         AND block_reason IS NOT NULL
       GROUP BY host, block_reason
       ORDER BY n DESC LIMIT 100`,
  ).all<{ host: string; block_reason: string; n: number; last_at: string }>();

  const r429 = await c.env.DB.prepare(
    `SELECT host, COUNT(*) AS n, MAX(created_at) AS last_at
       FROM fetch_log
       WHERE created_at >= datetime('now','-24 hours') AND status = 429
       GROUP BY host ORDER BY n DESC LIMIT 50`,
  ).all<{ host: string; n: number; last_at: string }>();

  const robotsAge = await c.env.DB.prepare(
    `SELECT host, robots_cached_at
       FROM crawler_host_config
       WHERE robots_cached_at IS NOT NULL
       ORDER BY robots_cached_at ASC LIMIT 25`,
  ).all<{ host: string; robots_cached_at: string }>();

  return c.json({
    refusals: refusals.results ?? [],
    rate_limit_429: r429.results ?? [],
    stalest_robots: robotsAge.results ?? [],
  });
});

// ------------------------------------------------------------ EXTRACTIONS
opsCrawlerRoute.get("/extractions", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.run_at, r.candidate_url, r.candidate_host,
            r.profile_type_id, t.label AS profile_type_label,
            r.status, r.entity_id, r.facts_written, r.facts_verified,
            r.ai_neurons, r.actual_cost_usd, r.duration_ms, r.errors_json
       FROM profile_workflow_runs r
       LEFT JOIN e_types t ON t.id = r.profile_type_id
       ORDER BY r.run_at DESC LIMIT ?`,
  ).bind(limit).all<Record<string, unknown>>();
  return c.json({ items: rows.results ?? [] });
});

// ------------------------------------------------------------ AUDIT
opsCrawlerRoute.get("/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const rows = await c.env.DB.prepare(
    `SELECT id, actor_email, action, target_kind, target_id, payload_json, created_at
       FROM ops_audit ORDER BY id DESC LIMIT ?`,
  ).bind(limit).all<Record<string, unknown>>();
  return c.json({ items: rows.results ?? [] });
});

// ============================================================ CONTROLS

// Pause / resume the global crawler. Uses the SESSIONS KV as a kill-switch
// flag the crawler consults before fetching. (Crawler integration is
// out-of-band; here we own the flag + the audit row.)
opsCrawlerRoute.post("/pause", async (c) => {
  const reason = (await c.req.json().catch(() => ({}))).reason ?? null;
  await c.env.SESSIONS.put("ops:crawler:paused", "1", { metadata: { reason, at: new Date().toISOString() } });
  await audit(c.env, c.var.email, "pause.all", "global", null, { reason });
  return c.json({ ok: true, paused: true });
});

opsCrawlerRoute.post("/resume", async (c) => {
  await c.env.SESSIONS.delete("ops:crawler:paused");
  await audit(c.env, c.var.email, "resume.all", "global", null, null);
  return c.json({ ok: true, paused: false });
});

opsCrawlerRoute.get("/pause-status", async (c) => {
  const v = await c.env.SESSIONS.get("ops:crawler:paused");
  return c.json({ paused: v === "1" });
});

// Per-host: quarantine / unquarantine / set RPS / clear robots cache.
opsCrawlerRoute.post("/hosts/:host/quarantine", async (c) => {
  const host = c.req.param("host").toLowerCase();
  const body = await c.req.json().catch(() => ({})) as { until?: string; reason?: string };
  const until = body.until ?? null;
  const reason = body.reason ?? null;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO crawler_host_config (host, quarantined_at, quarantined_until, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET
       quarantined_at = excluded.quarantined_at,
       quarantined_until = excluded.quarantined_until,
       last_error = COALESCE(excluded.last_error, crawler_host_config.last_error),
       updated_at = excluded.updated_at`,
  ).bind(host, now, until, reason, now).run();
  await audit(c.env, c.var.email, "host.quarantine", "host", host, { until, reason });
  return c.json({ ok: true, host, quarantined_at: now, quarantined_until: until });
});

opsCrawlerRoute.post("/hosts/:host/unquarantine", async (c) => {
  const host = c.req.param("host").toLowerCase();
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE crawler_host_config
        SET quarantined_at = NULL, quarantined_until = NULL, updated_at = ?
      WHERE host = ?`,
  ).bind(now, host).run();
  await audit(c.env, c.var.email, "host.unquarantine", "host", host, null);
  return c.json({ ok: true, host, changes: r.meta?.changes ?? 0 });
});

opsCrawlerRoute.post("/hosts/:host/rps", async (c) => {
  const host = c.req.param("host").toLowerCase();
  const body = await c.req.json().catch(() => ({})) as { max_rps?: number };
  const rps = Number(body.max_rps);
  if (!Number.isFinite(rps) || rps <= 0 || rps > 50) {
    return c.json({ error: "invalid_max_rps" }, 400);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO crawler_host_config (host, max_rps, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET max_rps = excluded.max_rps, updated_at = excluded.updated_at`,
  ).bind(host, rps, now).run();
  await audit(c.env, c.var.email, "host.set_rps", "host", host, { max_rps: rps });
  return c.json({ ok: true, host, max_rps: rps });
});

opsCrawlerRoute.post("/hosts/:host/clear-robots", async (c) => {
  const host = c.req.param("host").toLowerCase();
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE crawler_host_config
        SET robots_cached_at = NULL, robots_body = NULL, updated_at = ?
      WHERE host = ?`,
  ).bind(now, host).run();
  await audit(c.env, c.var.email, "host.clear_robots", "host", host, null);
  return c.json({ ok: true, host, changes: r.meta?.changes ?? 0 });
});

// Force-recrawl an entity (re-enqueues a workflow if the binding is
// configured; otherwise records the intent in the audit log).
opsCrawlerRoute.post("/recrawl-entity", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { entity_id?: string; reason?: string };
  const entityId = body.entity_id;
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);
  let dispatched: string | null = null;
  try {
    if (c.env.WF_REFRESH_NEWS) {
      const wf = await c.env.WF_REFRESH_NEWS.create({ params: { entityId, triggered_by: `ops:${c.var.email}` } });
      dispatched = wf.id;
    }
  } catch (e) {
    console.warn("recrawl-entity dispatch failed", (e as Error).message);
  }
  await audit(c.env, c.var.email, "recrawl.entity", "entity", entityId, { reason: body.reason ?? null, dispatched });
  return c.json({ ok: true, entity_id: entityId, dispatched });
});

// Test-fetch a URL and run the heuristic+AI page classifier. Read-only —
// writes no facts. Still audited because it consumes budget.
opsCrawlerRoute.post("/test-url", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { url?: string };
  const url = body.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return c.json({ error: "url_required" }, 400);
  }
  const t0 = Date.now();
  let fetched: { status: number; html_length: number; tier: number | null; blockReason: string | null } | null = null;
  let classification: unknown = null;
  let error: string | null = null;
  try {
    const r = await fetchPage(c.env, url, { jobId: `ops-test-${crypto.randomUUID()}` });
    fetched = {
      status: r.status,
      html_length: typeof r.html === "string" ? r.html.length : 0,
      tier: typeof r.tier === "number" ? r.tier : null,
      blockReason: r.blockReason ?? null,
    };
    if (r.status >= 200 && r.status < 300 && typeof r.html === "string" && r.html.length > 0) {
      classification = await classifyPage(c.env, url, r.html);
    }
    // Mark the host as tested in the host_config (helps the operator
    // see when a manual probe last hit a host even if there were no
    // production crawls).
    try {
      const host = new URL(url).hostname.toLowerCase();
      const now = new Date().toISOString();
      await c.env.DB.prepare(
        `INSERT INTO crawler_host_config (host, last_tested_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(host) DO UPDATE SET last_tested_at = excluded.last_tested_at, updated_at = excluded.updated_at`,
      ).bind(host, now, now).run();
    } catch { /* host parse already validated above */ }
  } catch (e) {
    error = (e as Error).message;
  }
  const duration_ms = Date.now() - t0;
  await audit(c.env, c.var.email, "test-url", "url", url, { fetched, classification, error, duration_ms });
  return c.json({ ok: error === null, url, fetched, classification, error, duration_ms });
});
