// Task #2: Crawler Operator Console — read aggregates + control plane.
//
// All routes inherit `accessGuard` + `adminOnly` from the parent mount
// (`/api/ops/*`) in index.ts. Every MUTATING endpoint writes an
// `ops_audit` row BEFORE performing the action (per spec: actions are
// idempotent enough that the audit trail must precede the mutation —
// otherwise a crash after the mutation but before the audit insert
// leaves no record of who did what).
//
// Reads target existing telemetry tables — no new write paths:
//   * fetch_log (015)            — legacy scraper attempts (canonical
//                                  surface for throughput + compliance)
//   * crawler_fetch_log (341)    — in-house crawler attempts
//   * crawler_host_config (341)  — per-host politeness + quarantine
//   * smart_frontier (342)       — typed staging queue
//   * crawler_frontier (341)     — Task #2 url-keyed work queue
//   * crawler_seeds (342)        — per-type seeds
//   * ai_cost_daily (150)        — AI spend roll-up
//   * profile_workflow_runs (345)— typed workflow outcomes (per-type
//                                  "adapter" scoreboard + extractions)
//
// DRIFT ALERT SURFACE: `alert_events` (migration 280) has a CHECK
// constraint on `trigger_kind` that does not include a crawler-drift
// kind; the existing insight surface for ops drift is therefore
// `ops_audit` rows with `action='drift.detected'`. The console reads
// them via `GET /drift-alerts` and renders a banner.

import { Hono } from "hono";
import type { Env } from "../types";
import { fetchPage, readCachedHtml } from "../scraper/fetcher";
import { classifyPage } from "../services/pageClassifier";
import { extractCandidates } from "../crawler/extractor";

type Vars = { email: string; is_admin: boolean };

export const opsCrawlerRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

const PAUSE_KEY_GLOBAL = "ops:crawler:paused";
const pauseKeyHost = (h: string) => `ops:crawler:paused:host:${h.toLowerCase()}`;
const pauseKeyType = (t: string) => `ops:crawler:paused:type:${t}`;
const THROUGHPUT_CACHE_KEY = "ops:throughput:v2";
const THROUGHPUT_TTL_S = 10;

// Fail-closed: callers invoke audit() BEFORE performing the mutating
// side-effect. If the audit row cannot be persisted we throw so the
// route returns 500 and the mutation is aborted — the
// "every mutation writes ops_audit" invariant is enforced even under
// DB failure.
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
      actor, action, target_kind, target_id,
      payload === undefined ? null : JSON.stringify(payload),
    ).run();
  } catch (e) {
    console.error("ops_audit insert failed", (e as Error).message);
    throw new Error("audit_failed: " + (e as Error).message);
  }
}

/** Compute a percentile from a sorted ascending number array. */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

opsCrawlerRoute.get("/", (c) =>
  c.json({
    ok: true,
    message: "ops crawler",
    // Task #6: expose proxy_configured at the root so the ops page
    // can render the "Proxy unconfigured" banner on its initial
    // 200-OK gate probe, without a second round trip.
    proxy_configured: Boolean(c.env.PROXY_URL),
    endpoints: [
      "GET /throughput", "GET /hosts", "GET /frontier", "GET /seeds",
      "GET /seeds/raw", "GET /adapters", "GET /ai-spend?window=day|month",
      "GET /compliance", "GET /extractions", "GET /audit",
      "GET /drift-alerts", "GET /pause-status",
      "GET /skipped", "GET /skipped/gated-paste", "GET /db-errors",
      "POST /pause {scope,target?}", "POST /resume {scope,target?}",
      "POST /hosts/:host/test", "POST /hosts/:host/quarantine",
      "POST /hosts/:host/unquarantine", "POST /hosts/:host/whitelist",
      "POST /hosts/:host/rps", "POST /hosts/:host/clear-robots",
      "POST /seeds", "POST /recrawl-entity",
      "POST /extractions/:id/replay", "POST /test-url",
      "POST /cleanup-tos-blocked",
    ],
  }),
);

// SKIPPED-BY-REASON (Task #6) — last 24h tally of queue-preflight skips.
// Skipped jobs are NOT errors and never write to error_log; this is
// the canonical surface to see them. Returns counts grouped by
// skip_reason + total + a small sample of recent rows.
opsCrawlerRoute.get("/skipped", async (c) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const byReason = await c.env.DB.prepare(
    `SELECT skip_reason AS reason, COUNT(*) AS n
       FROM jobs
      WHERE status = 'skipped' AND finished_at >= ?
      GROUP BY skip_reason
      ORDER BY n DESC`,
  ).bind(since).all<{ reason: string; n: number }>().catch(() => ({ results: [] as { reason: string; n: number }[] }));
  const recent = await c.env.DB.prepare(
    `SELECT id, name, source, kind, target, skip_reason, error, finished_at
       FROM jobs
      WHERE status = 'skipped' AND finished_at >= ?
      ORDER BY finished_at DESC
      LIMIT 25`,
  ).bind(since).all<{
    id: string; name: string | null; source: string | null;
    kind: string | null; target: string | null;
    skip_reason: string | null; error: string | null; finished_at: string;
  }>().catch(() => ({ results: [] as Array<Record<string, unknown>> }));
  const rows = (byReason as { results?: { reason: string; n: number }[] }).results ?? [];
  const total = rows.reduce((s, r) => s + Number(r.n ?? 0), 0);
  return c.json({
    window_hours: 24,
    proxy_configured: Boolean(c.env.PROXY_URL),
    total,
    by_reason: rows,
    recent: (recent as { results?: Array<Record<string, unknown>> }).results ?? [],
  });
});

// GATED-SOURCE QUEUE (Task #6) — distinct URLs the preflight has
// rejected with `gated_source_use_manual_paste`, grouped by host so
// operators can see what needs a manual paste. Last 7d.
opsCrawlerRoute.get("/skipped/gated-paste", async (c) => {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT target AS url, COUNT(*) AS attempts, MAX(finished_at) AS last_seen
       FROM jobs
      WHERE status = 'skipped'
        AND skip_reason = 'gated_source_use_manual_paste'
        AND finished_at >= ?
      GROUP BY target
      ORDER BY last_seen DESC
      LIMIT 200`,
  ).bind(since).all<{ url: string; attempts: number; last_seen: string }>()
    .catch(() => ({ results: [] as { url: string; attempts: number; last_seen: string }[] }));
  return c.json({
    window_hours: 24 * 7,
    items: (rows as { results?: { url: string; attempts: number; last_seen: string }[] }).results ?? [],
  });
});

// CLEANUP-TOS-BLOCKED (Task #6) — one-shot sweep of the existing
// backlog of ToS-blocked URLs from crawl_frontier + smart_frontier.
// Idempotent. Writes an ops_audit row BEFORE the mutation per the
// file-header invariant.
opsCrawlerRoute.post("/cleanup-tos-blocked", async (c) => {
  await audit(c.env, c.var.email, "frontier.cleanup_tos_blocked", null, null, null);
  const { cleanupTosBlockedFrontier } = await import("../services/frontier/tosSink");
  const r = await cleanupTosBlockedFrontier(c.env);
  return c.json({ ok: true, ...r });
});

// ============================================================ READS

// THROUGHPUT — 1-min buckets for last 60 min, p50/p95 per tier, KV-cached.
opsCrawlerRoute.get("/throughput", async (c) => {
  const cached = await c.env.SCRAPE_CACHE.get(THROUGHPUT_CACHE_KEY, "json");
  if (cached) return c.json(cached as Record<string, unknown>);

  const db = c.env.DB;
  const minutely = await db.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M:00Z', created_at) AS bucket,
            tier,
            COUNT(*)                                                    AS attempts,
            SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok
       FROM fetch_log
       WHERE created_at >= datetime('now','-60 minutes')
       GROUP BY bucket, tier
       ORDER BY bucket ASC, tier ASC`,
  ).all<{ bucket: string; tier: number; attempts: number; ok: number }>();

  // Pull durations per tier (capped) for percentile calc.
  const dur = await db.prepare(
    `SELECT tier, duration_ms
       FROM fetch_log
       WHERE created_at >= datetime('now','-60 minutes') AND duration_ms > 0
       ORDER BY created_at DESC LIMIT 5000`,
  ).all<{ tier: number; duration_ms: number }>();
  const byTier = new Map<number, number[]>();
  for (const r of dur.results ?? []) {
    if (!byTier.has(r.tier)) byTier.set(r.tier, []);
    byTier.get(r.tier)!.push(r.duration_ms);
  }
  const tierStats: Array<{ tier: number; p50: number; p95: number; samples: number }> = [];
  for (const [tier, arr] of byTier) {
    arr.sort((a, b) => a - b);
    tierStats.push({ tier, p50: pct(arr, 50), p95: pct(arr, 95), samples: arr.length });
  }
  tierStats.sort((a, b) => a.tier - b.tier);

  const totals = await db.prepare(
    `SELECT COUNT(*)                                                    AS attempts,
            SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END)               AS rate_limited,
            SUM(CASE WHEN block_reason IS NOT NULL THEN 1 ELSE 0 END)   AS blocked,
            COALESCE(SUM(bytes), 0)                                     AS bytes
       FROM fetch_log
       WHERE created_at >= datetime('now','-60 minutes')`,
  ).first<{ attempts: number; ok: number; rate_limited: number; blocked: number; bytes: number }>();

  const attempts = totals?.attempts ?? 0;
  const ok = totals?.ok ?? 0;
  const payload = {
    window_minutes: 60,
    last_hour: {
      attempts, ok,
      rate_limited: totals?.rate_limited ?? 0,
      blocked: totals?.blocked ?? 0,
      bytes: totals?.bytes ?? 0,
      success_rate_pct: attempts > 0 ? +((ok / attempts) * 100).toFixed(1) : null,
      pages_per_sec: +(attempts / 3600).toFixed(3),
    },
    minutely: minutely.results ?? [],
    tier_stats: tierStats,
    cached_at: new Date().toISOString(),
  };
  // Cache for 10s.
  c.executionCtx.waitUntil(
    c.env.SCRAPE_CACHE.put(THROUGHPUT_CACHE_KEY, JSON.stringify(payload), { expirationTtl: THROUGHPUT_TTL_S })
      .catch(() => undefined),
  );
  return c.json(payload);
});

// HOST HEALTH
opsCrawlerRoute.get("/hosts", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "200"), 500);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const status = c.req.query("status") ?? "";
  let where = "1=1";
  const binds: Array<string | number> = [];
  if (q) { where += " AND LOWER(host) LIKE ?"; binds.push(`%${q}%`); }
  if (status === "quarantined") where += " AND (quarantined_at IS NOT NULL OR quarantined_until IS NOT NULL)";
  if (status === "whitelisted") where += " AND notes = 'ops:whitelist'";
  binds.push(limit);

  const cfg = await c.env.DB.prepare(
    `SELECT host, recommended_tier, max_rps, robots_cached_at,
            quarantined_until, quarantined_at, last_success_at,
            last_error, last_tested_at, success_count, failure_count,
            notes, updated_at
       FROM crawler_host_config WHERE ${where}
       ORDER BY (failure_count * 1.0 / NULLIF(success_count + failure_count, 0)) DESC NULLS LAST,
                failure_count DESC, host ASC
       LIMIT ?`,
  ).bind(...binds).all<Record<string, unknown>>();

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
    const whitelisted = String(row.notes || "") === "ops:whitelist";
    return { ...row, ...r, success_rate_pct: successRate, whitelisted };
  });
  return c.json({ items });
});

// FRONTIER — pending counts per discovery_reason + oldest pending age.
opsCrawlerRoute.get("/frontier", async (c) => {
  const db = c.env.DB;
  const byTypeStatus = await db.prepare(
    `SELECT profile_type_id, status, COUNT(*) AS n
       FROM smart_frontier GROUP BY profile_type_id, status`,
  ).all<{ profile_type_id: string | null; status: string; n: number }>();

  const queue = await db.prepare(
    `SELECT status, COUNT(*) AS n FROM crawler_frontier GROUP BY status`,
  ).all<{ status: string; n: number }>().catch(() => ({ results: [] as Array<{ status: string; n: number }> }));

  const oldest = await db.prepare(
    `SELECT MIN(discovered_at) AS oldest_queued FROM smart_frontier WHERE status='queued'`,
  ).first<{ oldest_queued: string | null }>();

  const byReason = await db.prepare(
    `SELECT discovery_reason, COUNT(*) AS pending,
            MIN(discovered_at) AS oldest
       FROM smart_frontier WHERE status='queued'
       GROUP BY discovery_reason ORDER BY pending DESC LIMIT 30`,
  ).all<{ discovery_reason: string; pending: number; oldest: string }>();

  return c.json({
    smart_frontier: byTypeStatus.results ?? [],
    crawl_frontier: queue.results ?? [],
    oldest_queued: oldest?.oldest_queued ?? null,
    by_reason: byReason.results ?? [],
  });
});

// SEEDS — per-profile_type_id rollup (spec primary view).
opsCrawlerRoute.get("/seeds", async (c) => {
  const rollup = await c.env.DB.prepare(
    `SELECT s.profile_type_id,
            t.label AS profile_type_label,
            COUNT(*)                                       AS seeds_total,
            SUM(s.enabled)                                 AS seeds_enabled,
            MAX(s.last_crawled_at)                         AS last_crawled_at,
            COALESCE(SUM(s.success_count), 0)              AS success_count,
            COALESCE(SUM(s.entity_count),  0)              AS entities_discovered
       FROM crawler_seeds s
       LEFT JOIN e_types t ON t.id = s.profile_type_id
       GROUP BY s.profile_type_id
       ORDER BY entities_discovered DESC, seeds_total DESC
       LIMIT 200`,
  ).all<Record<string, unknown>>();
  const items = (rollup.results ?? []).map((r) => {
    const succ = Number(r.success_count) || 0;
    const ent = Number(r.entities_discovered) || 0;
    return { ...r, success_ratio: succ > 0 ? +(ent / succ).toFixed(3) : null };
  });
  return c.json({ items });
});

// SEEDS RAW — full per-seed listing (used for the operator detail table).
opsCrawlerRoute.get("/seeds/raw", async (c) => {
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

// ADAPTERS — per-profile-type workflow scoreboard.
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
       ORDER BY runs_7d DESC LIMIT 200`,
  ).all<Record<string, number | string>>();

  // Cross-reference with last drift event from ops_audit.
  const drifts = await c.env.DB.prepare(
    `SELECT target_id, MAX(created_at) AS last_drift_at
       FROM ops_audit WHERE action='drift.detected' AND target_kind='profile_type'
       GROUP BY target_id`,
  ).all<{ target_id: string; last_drift_at: string }>();
  const driftMap = new Map((drifts.results ?? []).map((d) => [d.target_id, d.last_drift_at]));

  const items = (rows.results ?? []).map((r) => {
    const runs = Number(r.runs_7d) || 0;
    const ok = Number(r.success) || 0;
    return {
      ...r,
      parse_success_pct: runs > 0 ? +((ok / runs) * 100).toFixed(1) : null,
      last_drift_at: driftMap.get(String(r.profile_type_id)) ?? null,
    };
  });
  return c.json({ items });
});

// AI SPEND — window=day (today) or month (MTD), tokens-centric.
opsCrawlerRoute.get("/ai-spend", async (c) => {
  const window = c.req.query("window") === "month" ? "month" : "day";
  const windowFilter = window === "month" ? "date('now','start of month')" : "date('now')";

  const total = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd,
            COALESCE(SUM(neurons), 0)  AS neurons,
            COALESCE(SUM(calls), 0)    AS calls
       FROM ai_cost_daily WHERE day >= ${windowFilter}`,
  ).first<{ cost_usd: number; neurons: number; calls: number }>();

  const byPurpose = await c.env.DB.prepare(
    `SELECT purpose, SUM(cost_usd) AS cost_usd, SUM(calls) AS calls,
            SUM(neurons) AS neurons
       FROM ai_cost_daily WHERE day >= ${windowFilter}
       GROUP BY purpose ORDER BY cost_usd DESC`,
  ).all<{ purpose: string; cost_usd: number; calls: number; neurons: number }>();

  const byType = await c.env.DB.prepare(
    `SELECT r.profile_type_id, t.label AS profile_type_label,
            SUM(r.actual_cost_usd) AS cost_usd, SUM(r.ai_calls) AS ai_calls,
            SUM(r.ai_neurons) AS neurons
       FROM profile_workflow_runs r
       LEFT JOIN e_types t ON t.id = r.profile_type_id
       WHERE r.run_at >= datetime(${windowFilter})
       GROUP BY r.profile_type_id ORDER BY cost_usd DESC LIMIT 50`,
  ).all<Record<string, unknown>>();

  const daily = await c.env.DB.prepare(
    `SELECT day, SUM(cost_usd) AS cost_usd, SUM(neurons) AS neurons, SUM(calls) AS calls
       FROM ai_cost_daily WHERE day >= date('now','-30 days')
       GROUP BY day ORDER BY day ASC`,
  ).all<{ day: string; cost_usd: number; neurons: number; calls: number }>();

  return c.json({
    window,
    total: total ?? { cost_usd: 0, neurons: 0, calls: 0 },
    by_purpose: byPurpose.results ?? [],
    by_profile_type: byType.results ?? [],
    daily: daily.results ?? [],
  });
});

// COMPLIANCE — robots fetches, 429s, explicit-disallow hosts.
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

// EXTRACTIONS — last N workflow runs with URL + detected type + status.
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
  // Confidence isn't directly stored on profile_workflow_runs; we
  // approximate it by the share of facts that crossed the verifier
  // (verified / written). Null if no facts were written.
  const items = (rows.results ?? []).map((r) => {
    const w = Number(r.facts_written) || 0;
    const v = Number(r.facts_verified) || 0;
    return { ...r, confidence: w > 0 ? +(v / w).toFixed(3) : null };
  });
  return c.json({ items });
});

opsCrawlerRoute.get("/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const rows = await c.env.DB.prepare(
    `SELECT id, actor_email, action, target_kind, target_id, payload_json, created_at
       FROM ops_audit ORDER BY id DESC LIMIT ?`,
  ).bind(limit).all<Record<string, unknown>>();
  return c.json({ items: rows.results ?? [] });
});

// DRIFT ALERTS — last 14d of drift.detected ops_audit rows; powers the
// banner on the operator console and serves as the ops-side feed into
// the insights surface.
opsCrawlerRoute.get("/drift-alerts", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, target_id AS profile_type_id, payload_json, created_at
       FROM ops_audit
       WHERE action='drift.detected' AND target_kind='profile_type'
         AND created_at >= datetime('now','-14 days')
       ORDER BY id DESC LIMIT 50`,
  ).all<Record<string, unknown>>();
  return c.json({ items: rows.results ?? [] });
});

opsCrawlerRoute.get("/pause-status", async (c) => {
  const global = await c.env.SESSIONS.get(PAUSE_KEY_GLOBAL);
  const hostList = await c.env.SESSIONS.list({ prefix: "ops:crawler:paused:host:" });
  const typeList = await c.env.SESSIONS.list({ prefix: "ops:crawler:paused:type:" });
  return c.json({
    paused: global === "1",
    paused_hosts: hostList.keys.map((k) => k.name.replace("ops:crawler:paused:host:", "")),
    paused_profile_types: typeList.keys.map((k) => k.name.replace("ops:crawler:paused:type:", "")),
  });
});

// ============================================================ CONTROLS
// Convention: every mutating endpoint AUDITS FIRST, then performs the
// action. The audit row is the source of truth for "this action was
// attempted by X at Y" even if the mutation later throws.

// SCOPED PAUSE — {scope: 'all'|'host'|'profile_type', target?: string}
opsCrawlerRoute.post("/pause", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { scope?: string; target?: string; reason?: string };
  const scope = body.scope ?? "all";
  const target = body.target ?? null;
  if (scope !== "all" && scope !== "host" && scope !== "profile_type") {
    return c.json({ error: "invalid_scope" }, 400);
  }
  if ((scope === "host" || scope === "profile_type") && !target) {
    return c.json({ error: "target_required" }, 400);
  }
  await audit(c.env, c.var.email, `pause.${scope}`, scope, target, { reason: body.reason ?? null });
  const key = scope === "all" ? PAUSE_KEY_GLOBAL
    : scope === "host" ? pauseKeyHost(target!) : pauseKeyType(target!);
  await c.env.SESSIONS.put(key, "1", { metadata: { reason: body.reason ?? null, at: new Date().toISOString(), actor: c.var.email } });
  return c.json({ ok: true, scope, target, paused: true });
});

opsCrawlerRoute.post("/resume", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { scope?: string; target?: string };
  const scope = body.scope ?? "all";
  const target = body.target ?? null;
  if (scope !== "all" && scope !== "host" && scope !== "profile_type") {
    return c.json({ error: "invalid_scope" }, 400);
  }
  if ((scope === "host" || scope === "profile_type") && !target) {
    return c.json({ error: "target_required" }, 400);
  }
  await audit(c.env, c.var.email, `resume.${scope}`, scope, target, null);
  const key = scope === "all" ? PAUSE_KEY_GLOBAL
    : scope === "host" ? pauseKeyHost(target ?? "")
    : pauseKeyType(target ?? "");
  await c.env.SESSIONS.delete(key);
  return c.json({ ok: true, scope, target, paused: false });
});

// HOST CONTROLS
opsCrawlerRoute.post("/hosts/:host/quarantine", async (c) => {
  const host = c.req.param("host").toLowerCase();
  const body = await c.req.json().catch(() => ({})) as { until?: string; reason?: string };
  await audit(c.env, c.var.email, "host.quarantine", "host", host, body);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO crawler_host_config (host, quarantined_at, quarantined_until, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET
       quarantined_at    = excluded.quarantined_at,
       quarantined_until = excluded.quarantined_until,
       last_error        = COALESCE(excluded.last_error, crawler_host_config.last_error),
       updated_at        = excluded.updated_at`,
  ).bind(host, now, body.until ?? null, body.reason ?? null, now).run();
  return c.json({ ok: true, host, quarantined_at: now, quarantined_until: body.until ?? null });
});

opsCrawlerRoute.post("/hosts/:host/unquarantine", async (c) => {
  const host = c.req.param("host").toLowerCase();
  await audit(c.env, c.var.email, "host.unquarantine", "host", host, null);
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE crawler_host_config
        SET quarantined_at = NULL, quarantined_until = NULL, updated_at = ?
      WHERE host = ?`,
  ).bind(now, host).run();
  return c.json({ ok: true, host, changes: r.meta?.changes ?? 0 });
});

// WHITELIST — mark a host as trusted: clears quarantine, stamps the
// notes field with the sentinel `ops:whitelist`. Whitelisted hosts are
// visible in the /hosts filter (status=whitelisted).
opsCrawlerRoute.post("/hosts/:host/whitelist", async (c) => {
  const host = c.req.param("host").toLowerCase();
  await audit(c.env, c.var.email, "host.whitelist", "host", host, null);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO crawler_host_config (host, notes, quarantined_at, quarantined_until, updated_at)
     VALUES (?, 'ops:whitelist', NULL, NULL, ?)
     ON CONFLICT(host) DO UPDATE SET
       notes = 'ops:whitelist',
       quarantined_at = NULL, quarantined_until = NULL,
       updated_at = excluded.updated_at`,
  ).bind(host, now).run();
  return c.json({ ok: true, host, whitelisted: true });
});

opsCrawlerRoute.post("/hosts/:host/rps", async (c) => {
  const host = c.req.param("host").toLowerCase();
  const body = await c.req.json().catch(() => ({})) as { max_rps?: number };
  const rps = Number(body.max_rps);
  if (!Number.isFinite(rps) || rps <= 0 || rps > 50) {
    return c.json({ error: "invalid_max_rps" }, 400);
  }
  await audit(c.env, c.var.email, "host.set_rps", "host", host, { max_rps: rps });
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO crawler_host_config (host, max_rps, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET max_rps = excluded.max_rps, updated_at = excluded.updated_at`,
  ).bind(host, rps, now).run();
  return c.json({ ok: true, host, max_rps: rps });
});

opsCrawlerRoute.post("/hosts/:host/clear-robots", async (c) => {
  const host = c.req.param("host").toLowerCase();
  await audit(c.env, c.var.email, "host.clear_robots", "host", host, null);
  const now = new Date().toISOString();
  const r = await c.env.DB.prepare(
    `UPDATE crawler_host_config
        SET robots_cached_at = NULL, robots_body = NULL, updated_at = ?
      WHERE host = ?`,
  ).bind(now, host).run();
  return c.json({ ok: true, host, changes: r.meta?.changes ?? 0 });
});

// TEST FETCH for a single host — probes https://{host}/ and returns
// the fetch result + classification. Read-only; updates last_tested_at.
opsCrawlerRoute.post("/hosts/:host/test", async (c) => {
  const host = c.req.param("host").toLowerCase();
  // Basic host validation: reject anything that isn't a plausible
  // DNS-ish token (prevents URL injection via path param).
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    return c.json({ error: "invalid_host" }, 400);
  }
  const url = `https://${host}/`;
  await audit(c.env, c.var.email, "host.test_fetch", "host", host, { url });
  const t0 = Date.now();
  let fetched: Record<string, unknown> | null = null;
  let classification: unknown = null;
  let error: string | null = null;
  try {
    const r = await fetchPage(c.env, url, { jobId: `ops-host-test-${crypto.randomUUID()}` });
    fetched = { status: r.status, html_length: r.html?.length ?? 0, tier: r.tier, blockReason: r.blockReason ?? null };
    if (r.status >= 200 && r.status < 300 && typeof r.html === "string" && r.html.length > 0) {
      classification = await classifyPage(c.env, url, r.html);
    }
  } catch (e) { error = (e as Error).message; }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO crawler_host_config (host, last_tested_at, last_error, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET
       last_tested_at = excluded.last_tested_at,
       last_error     = COALESCE(excluded.last_error, crawler_host_config.last_error),
       updated_at     = excluded.updated_at`,
  ).bind(host, now, error, now).run();
  return c.json({ ok: error === null, host, url, fetched, classification, error, duration_ms: Date.now() - t0 });
});

// ADD SEED — thin proxy into the existing crawler-seeds insert path.
opsCrawlerRoute.post("/seeds", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    profile_type_id?: string; seed_kind?: string; value?: string;
    refresh_interval_hours?: number; enabled?: boolean; notes?: string;
  };
  const ptid = String(body.profile_type_id ?? "").trim();
  const kind = String(body.seed_kind ?? "").trim();
  const value = String(body.value ?? "").trim();
  if (!ptid || !kind || !value) return c.json({ error: "missing_fields" }, 400);
  if (!["url", "search_query", "directory_pattern"].includes(kind)) return c.json({ error: "bad_seed_kind" }, 400);
  await audit(c.env, c.var.email, "seed.add", "profile_type", ptid, { seed_kind: kind, value });

  // FK guard.
  const t = await c.env.DB.prepare(`SELECT id FROM e_types WHERE id = ?`).bind(ptid).first<{ id: string }>();
  if (!t) return c.json({ error: "unknown_profile_type_id" }, 400);
  const refresh = Math.max(1, Math.min(8760, Number(body.refresh_interval_hours ?? 168)));
  const enabled = body.enabled === false ? 0 : 1;
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 500) : null;
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO crawler_seeds (id, profile_type_id, seed_kind, value, refresh_interval_hours, enabled, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_type_id, seed_kind, value) DO UPDATE SET
         refresh_interval_hours = excluded.refresh_interval_hours,
         enabled                = excluded.enabled,
         notes                  = excluded.notes,
         updated_at             = CURRENT_TIMESTAMP`,
    ).bind(id, ptid, kind, value, refresh, enabled, notes).run();
  } catch (e) {
    return c.json({ error: "insert_failed", detail: (e as Error).message }, 500);
  }
  return c.json({ ok: true, profile_type_id: ptid, seed_kind: kind, value });
});

// RECRAWL ENTITY — re-enqueues every applicable per-type workflow for
// the entity (currently only the news-refresh workflow is bound — other
// per-type workflows are dispatched as they come online via WF_* bindings).
opsCrawlerRoute.post("/recrawl-entity", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { entity_id?: string; reason?: string };
  const entityId = body.entity_id;
  if (!entityId) return c.json({ error: "entity_id_required" }, 400);
  await audit(c.env, c.var.email, "recrawl.entity", "entity", entityId, { reason: body.reason ?? null });
  const dispatched: Record<string, string> = {};
  try {
    if (c.env.WF_REFRESH_NEWS) {
      const wf = await c.env.WF_REFRESH_NEWS.create({ params: { entityId, triggered_by: `ops:${c.var.email}` } });
      dispatched.news = wf.id;
    }
  } catch (e) { console.warn("recrawl news failed", (e as Error).message); }
  try {
    if (c.env.WF_CLASSIFY_BATCH) {
      const wf = await (c.env as unknown as { WF_CLASSIFY_BATCH?: { create: (o: { params: Record<string, unknown> }) => Promise<{ id: string }> } })
        .WF_CLASSIFY_BATCH?.create({ params: { entityIds: [entityId], triggered_by: `ops:${c.var.email}` } });
      if (wf) dispatched.classify = wf.id;
    }
  } catch (e) { console.warn("recrawl classify failed", (e as Error).message); }
  return c.json({ ok: true, entity_id: entityId, dispatched });
});

// REPLAY EXTRACT — re-run classifier + extractor against the CACHED
// HTML (written by fetchPage into SCRAPE_CACHE under html:<sha256(url)>
// with a 7d TTL). No live network fetch, no writes to facts/entities.
// Returns 410 no_cached_html when the snapshot has expired; the
// operator can then issue Test URL to re-fetch on demand.
opsCrawlerRoute.post("/extractions/:id/replay", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT id, candidate_url, profile_type_id FROM profile_workflow_runs WHERE id = ?`,
  ).bind(id).first<{ id: string; candidate_url: string; profile_type_id: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  await audit(c.env, c.var.email, "extraction.replay", "extraction", id, { candidate_url: row.candidate_url });
  const t0 = Date.now();
  let classification: unknown = null;
  let extraction: Record<string, unknown> | null = null;
  let error: string | null = null;
  const html = await readCachedHtml(c.env, row.candidate_url);
  if (!html) {
    return c.json({
      ok: false, extraction_id: id, candidate_url: row.candidate_url,
      profile_type_id: row.profile_type_id,
      error: "no_cached_html",
      message: "Cached HTML for this URL has expired (7d TTL). Use Test URL to re-fetch and re-cache.",
      duration_ms: Date.now() - t0,
    }, 410);
  }
  try {
    classification = await classifyPage(c.env, row.candidate_url, html);
    const ext = await extractCandidates(c.env, row.candidate_url, html);
    extraction = {
      route: ext.route, adapter_used: ext.adapter_used,
      adapter_fallback: ext.adapter_fallback, adapter_error: ext.adapter_error,
      used_ai: ext.used_ai, ai_error: ext.ai_error,
      matched_types: ext.matched_types, candidates: ext.candidates,
      child_urls: ext.child_urls,
    };
  } catch (e) { error = (e as Error).message; }
  return c.json({
    ok: error === null,
    extraction_id: id, candidate_url: row.candidate_url,
    profile_type_id: row.profile_type_id,
    source: "cached_html",
    html_length: html.length,
    classification, extraction, error,
    duration_ms: Date.now() - t0,
  });
});

// TEST URL — fetch + classify any URL, no commit. Audited because it
// burns budget (one tier-escalating fetch + one AI classifier call).
opsCrawlerRoute.post("/test-url", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { url?: string; html?: string };
  const url = body.url;
  const providedHtml = typeof body.html === "string" && body.html.length > 0 ? body.html : null;
  if (!url || !/^https?:\/\//i.test(url)) {
    return c.json({ error: "url_required" }, 400);
  }
  await audit(c.env, c.var.email, "test-url", "url", url, providedHtml ? { html_bytes: providedHtml.length } : null);
  const t0 = Date.now();
  let fetched: Record<string, unknown> | null = null;
  let classification: unknown = null;
  let extraction: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    // Dry-run mode: when {html} is provided, skip the network fetch
    // and run classifier + extractor against the supplied content.
    // This is the contract for operator-pasted HTML.
    let html: string | null = null;
    if (providedHtml) {
      fetched = { status: 200, html_length: providedHtml.length, tier: null, blockReason: null, source: "provided" };
      html = providedHtml;
    } else {
      const r = await fetchPage(c.env, url, { jobId: `ops-test-${crypto.randomUUID()}` });
      fetched = {
        status: r.status,
        html_length: typeof r.html === "string" ? r.html.length : 0,
        tier: typeof r.tier === "number" ? r.tier : null,
        blockReason: r.blockReason ?? null,
        source: "live",
      };
      if (r.status >= 200 && r.status < 300 && typeof r.html === "string" && r.html.length > 0) {
        html = r.html;
      }
    }
    if (html) {
      classification = await classifyPage(c.env, url, html);
      // Full extractor: adapter run + JSON-LD/OG/Readability/classifier
      // chain. No-commit — this endpoint only returns the result for
      // operator inspection; nothing is written to facts.
      const ext = await extractCandidates(c.env, url, html);
      extraction = {
        url: ext.url,
        route: ext.route,
        adapter_used: ext.adapter_used,
        adapter_fallback: ext.adapter_fallback,
        adapter_error: ext.adapter_error,
        used_ai: ext.used_ai,
        ai_error: ext.ai_error,
        matched_types: ext.matched_types,
        candidates: ext.candidates,
        child_urls: ext.child_urls,
      };
    }
    if (!providedHtml) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        const now = new Date().toISOString();
        await c.env.DB.prepare(
          `INSERT INTO crawler_host_config (host, last_tested_at, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(host) DO UPDATE SET last_tested_at = excluded.last_tested_at, updated_at = excluded.updated_at`,
        ).bind(host, now, now).run();
      } catch { /* host parse fine */ }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return c.json({ ok: error === null, url, fetched, classification, extraction, error, duration_ms: Date.now() - t0 });
});

// Task #7: deduped DB-errors panel. Groups `error_log` rows with
// code='db_error' from the last 7 days by (normalized SQLite message,
// route) so operators can see what's actually breaking instead of an
// opaque "223 db errors" counter.
//
// safeQuery pattern (matches Task #14): when the table is missing in
// a fresh env we return an empty payload — never throw.
opsCrawlerRoute.get("/db-errors", async (c) => {
  const days = Math.max(1, Math.min(30, Number(c.req.query("days") ?? 7) || 7));
  let rows: Array<{ message: string | null; cause_message: string | null; url: string | null; method: string | null }> = [];
  let tableMissing = false;
  try {
    const r = await c.env.DB.prepare(
      `SELECT message, cause_message, url, method
         FROM error_log
        WHERE code = 'db_error'
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC
        LIMIT 5000`,
    ).bind(`-${days} days`).all<{ message: string | null; cause_message: string | null; url: string | null; method: string | null }>();
    rows = r.results ?? [];
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/no such table|no such column/i.test(msg)) {
      tableMissing = true;
    } else {
      return c.json({ ok: false, error: "db_error_query_failed", message: msg }, 500);
    }
  }
  const { groupDbErrors } = await import("../db/dbErrorGrouper.js");
  const groups = groupDbErrors(rows);
  return c.json({
    ok: true,
    window_days: days,
    table_missing: tableMissing,
    total_rows: rows.length,
    groups,
  });
});
