// Task #5: System Health & Errors Dashboard — metric collectors.
//
// Each collector is a pure async function over `Env` that returns a
// typed snapshot for one panel. All source-table queries are wrapped
// in safeQuery() so a missing table in a cold-install / test DB
// degrades to an empty result rather than throwing — same honest-
// degradation pattern as Task #14 verification / Task #3 edge quality.
//
// Cron-budget reality: spec asked for 5-min rollups but Free plan
// has 5/5 crons. We piggyback the existing hourly cron `0 * * * *`
// and additionally write an on-demand snapshot inside the aggregator
// endpoint when the last bucket is >5 minutes old. Documented in
// replit.md under "Task #5 — System Health & Errors Dashboard".

import type { Env } from "../../types";

export interface ComputeNodeCard {
  id: string;
  name: string;
  provider: string;
  kind: string;
  status: "green" | "yellow" | "red" | "drained";
  current_active_jobs: number;
  max_concurrent_jobs: number;
  last_heartbeat_at: string | null;
  last_error: string | null;
  p95_latency_ms: number | null;
  enabled: number;
  drain: number;
}

export interface QueueCard {
  queue_name: string;
  depth: number;
  oldest_age_seconds: number | null;
  failed_24h: number;
  sparkline: Array<{ bucket: string; depth: number }>;
}

export interface ErrorSignature {
  signature: string;
  count: number;
  last_seen: string;
  sample_code: string;
  sample_message: string;
  sample_route: string | null;
}

export interface CronStatusRow {
  name: string;
  cron_expr: string;
  last_run: string | null;
  status: string | null;
  next_run_est: string | null;
}

export interface ExternalApiCard {
  api_name: string;
  configured: number;
  last_success: string | null;
  last_probe: string | null;
  success_rate_24h: number | null;
  rate_limit_remaining: number | null;
  last_error: string | null;
}

/** Wrap a D1 read so a missing-table error returns the supplied empty value. */
export async function safeQuery<T>(
  fn: () => Promise<T>,
  empty: T,
): Promise<T> {
  try {
    return await fn();
  } catch {
    return empty;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- compute pool ----------------------------------------------------

export async function collectComputePool(env: Env): Promise<ComputeNodeCard[]> {
  const rows = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT id, name, provider, kind, supported_job_types,
              max_concurrent_jobs, current_active_jobs,
              enabled, drain, last_heartbeat_at, last_error
         FROM compute_nodes
        ORDER BY registered_at DESC`,
    ).all<{
      id: string; name: string; provider: string; kind: string;
      supported_job_types: string; max_concurrent_jobs: number;
      current_active_jobs: number; enabled: number; drain: number;
      last_heartbeat_at: string | null; last_error: string | null;
    }>();
    return r.results ?? [];
  }, [] as Array<Record<string, unknown>>);

  // Per-node p95 latency over the last hour.
  const lat = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT node_id, runtime_ms
         FROM compute_job_assignments
        WHERE status='completed'
          AND completed_at >= datetime('now','-1 hour')
          AND runtime_ms IS NOT NULL`,
    ).all<{ node_id: string; runtime_ms: number }>();
    return r.results ?? [];
  }, [] as Array<{ node_id: string; runtime_ms: number }>);

  const byNode = new Map<string, number[]>();
  for (const row of lat) {
    const arr = byNode.get(row.node_id) ?? [];
    arr.push(Number(row.runtime_ms));
    byNode.set(row.node_id, arr);
  }

  return (rows as unknown as Array<{
    id: string; name: string; provider: string; kind: string;
    max_concurrent_jobs: number; current_active_jobs: number;
    enabled: number; drain: number;
    last_heartbeat_at: string | null; last_error: string | null;
  }>).map((node) => {
    const samples = (byNode.get(node.id) ?? []).slice().sort((a, b) => a - b);
    const p95 = samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] : null;
    return {
      id: node.id,
      name: node.name,
      provider: node.provider,
      kind: node.kind,
      status: nodeStatus(node),
      current_active_jobs: node.current_active_jobs,
      max_concurrent_jobs: node.max_concurrent_jobs,
      last_heartbeat_at: node.last_heartbeat_at,
      last_error: node.last_error,
      p95_latency_ms: p95,
      enabled: node.enabled,
      drain: node.drain,
    };
  });
}

export function nodeStatus(n: {
  enabled: number; drain: number;
  last_heartbeat_at: string | null; last_error: string | null;
}): "green" | "yellow" | "red" | "drained" {
  if (n.drain) return "drained";
  if (!n.enabled) return "red";
  if (!n.last_heartbeat_at) return "yellow";
  const ageMs = Date.now() - new Date(n.last_heartbeat_at).getTime();
  if (ageMs > 5 * 60_000) return "red";
  if (n.last_error) return "yellow";
  return "green";
}

// ---------- queues ----------------------------------------------------------

const KNOWN_QUEUES = [
  "aidatasignal-lead-jobs",
  "csv_imports",
  "crawl_frontier",
  "smart_frontier",
] as const;

export async function collectQueues(env: Env): Promise<QueueCard[]> {
  // jobs table is the canonical job queue (Task #2 stuck-job sweep
  // operates on it). csv_imports / crawl_frontier / smart_frontier
  // have their own tables.
  const out: QueueCard[] = [];

  // 1) jobs table (Cloudflare queue mirror).
  const jobsCard = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS depth,
         MIN(CASE WHEN status IN ('pending','running') THEN created_at END) AS oldest,
         SUM(CASE WHEN status='failed' AND created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS failed_24h
         FROM jobs`,
    ).first<{ depth: number | null; oldest: string | null; failed_24h: number | null }>();
    return r;
  }, null as { depth: number | null; oldest: string | null; failed_24h: number | null } | null);
  if (jobsCard) {
    out.push({
      queue_name: "aidatasignal-lead-jobs",
      depth: Number(jobsCard.depth ?? 0),
      oldest_age_seconds: jobsCard.oldest ? Math.max(0, Math.floor((Date.now() - new Date(jobsCard.oldest).getTime()) / 1000)) : null,
      failed_24h: Number(jobsCard.failed_24h ?? 0),
      sparkline: [],
    });
  } else {
    out.push({ queue_name: "aidatasignal-lead-jobs", depth: 0, oldest_age_seconds: null, failed_24h: 0, sparkline: [] });
  }

  // 2) csv_imports.
  const csv = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS depth,
         MIN(CASE WHEN status IN ('queued','running') THEN created_at END) AS oldest
         FROM csv_imports`,
    ).first<{ depth: number | null; oldest: string | null }>();
    return r;
  }, null as { depth: number | null; oldest: string | null } | null);
  out.push({
    queue_name: "csv_imports",
    depth: Number(csv?.depth ?? 0),
    oldest_age_seconds: csv?.oldest ? Math.max(0, Math.floor((Date.now() - new Date(csv.oldest).getTime()) / 1000)) : null,
    failed_24h: 0,
    sparkline: [],
  });

  // 3) crawl_frontier.
  const cf = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS depth, MIN(created_at) AS oldest
         FROM crawl_frontier WHERE status='pending'`,
    ).first<{ depth: number | null; oldest: string | null }>();
    return r;
  }, null as { depth: number | null; oldest: string | null } | null);
  out.push({
    queue_name: "crawl_frontier",
    depth: Number(cf?.depth ?? 0),
    oldest_age_seconds: cf?.oldest ? Math.max(0, Math.floor((Date.now() - new Date(cf.oldest).getTime()) / 1000)) : null,
    failed_24h: 0,
    sparkline: [],
  });

  // 4) smart_frontier (queued only).
  const sf = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS depth, MIN(created_at) AS oldest
         FROM smart_frontier WHERE status='queued'`,
    ).first<{ depth: number | null; oldest: string | null }>();
    return r;
  }, null as { depth: number | null; oldest: string | null } | null);
  out.push({
    queue_name: "smart_frontier",
    depth: Number(sf?.depth ?? 0),
    oldest_age_seconds: sf?.oldest ? Math.max(0, Math.floor((Date.now() - new Date(sf.oldest).getTime()) / 1000)) : null,
    failed_24h: 0,
    sparkline: [],
  });

  // Attach 60-minute sparkline from health_snapshots when available.
  for (const card of out) {
    const metric = `queue.depth.${card.queue_name}`;
    const sp = await safeQuery(async () => {
      const r = await env.DB.prepare(
        `SELECT bucket_start, value
           FROM health_snapshots
          WHERE metric_name = ?
            AND bucket_start >= datetime('now','-1 hour')
          ORDER BY bucket_start ASC`,
      ).bind(metric).all<{ bucket_start: string; value: number }>();
      return r.results ?? [];
    }, [] as Array<{ bucket_start: string; value: number }>);
    card.sparkline = sp.map((p) => ({ bucket: p.bucket_start, depth: Number(p.value ?? 0) }));
  }
  KNOWN_QUEUES; // referenced for documentation; queue list is built above
  return out;
}

// ---------- D1 -------------------------------------------------------------

export interface D1Card {
  reads_per_sec_estimate: number;
  writes_per_sec_estimate: number;
  errors_24h: number;
  throttled_24h: number;
}

export async function collectD1(env: Env): Promise<D1Card> {
  // Cloudflare doesn't expose D1 rates to the Worker; we estimate from
  // error_log + workflow_step_log activity. "throttled_24h" counts
  // error_log rows whose code/message indicate a D1 rate limit.
  const out: D1Card = {
    reads_per_sec_estimate: 0,
    writes_per_sec_estimate: 0,
    errors_24h: 0,
    throttled_24h: 0,
  };
  const errs = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN code='db_error' OR code='d1_error' OR code LIKE '%db%' THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN message LIKE '%TOO_MANY%' OR message LIKE '%throttl%' OR message LIKE '%rate%' THEN 1 ELSE 0 END) AS throttled
         FROM error_log
        WHERE created_at >= datetime('now','-1 day')`,
    ).first<{ errors: number | null; throttled: number | null }>();
    return r;
  }, null as { errors: number | null; throttled: number | null } | null);
  out.errors_24h = Number(errs?.errors ?? 0);
  out.throttled_24h = Number(errs?.throttled ?? 0);

  // Throughput estimate from workflow_step_log (steps/sec, lower bound
  // for write rate).
  const wr = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM workflow_step_log
        WHERE finished_at >= datetime('now','-5 minutes')
          AND status IN ('ok','error')`,
    ).first<{ n: number | null }>();
    return r;
  }, null as { n: number | null } | null);
  out.writes_per_sec_estimate = Number(wr?.n ?? 0) / 300;
  out.reads_per_sec_estimate = out.writes_per_sec_estimate * 3; // rough heuristic; reads >> writes
  return out;
}

// ---------- R2 / KV / Vectorize --------------------------------------------

export interface R2Card { bucket: string; bound: boolean; }
export interface KvCard { binding: string; bound: boolean; }
export interface VectorizeCard { index: string; bound: boolean; }

export function collectR2(env: Env): R2Card[] {
  return [
    { bucket: "RAW_HTML", bound: !!env.RAW_HTML },
    { bucket: "UPLOADS", bound: !!env.UPLOADS },
    { bucket: "AI_CACHE", bound: !!env.AI_CACHE },
    { bucket: "IMPORTS", bound: !!env.IMPORTS },
    { bucket: "TRANSCRIPTS", bound: !!env.TRANSCRIPTS },
  ];
}

export function collectKV(env: Env): KvCard[] {
  return [
    { binding: "SESSIONS", bound: !!env.SESSIONS },
    { binding: "SCRAPE_CACHE", bound: !!env.SCRAPE_CACHE },
  ];
}

export function collectVectorize(env: Env): VectorizeCard[] {
  return [
    { index: "VEC_LEADS", bound: !!env.VEC_LEADS },
    { index: "VEC_FIRMS", bound: !!env.VEC_FIRMS },
    { index: "VEC_COMPANIES", bound: !!env.VEC_COMPANIES },
    { index: "VEC_ACCOUNTS", bound: !!env.VEC_ACCOUNTS },
    { index: "VEC_PERSONAS", bound: !!env.VEC_PERSONAS },
    { index: "VEC_PROJECTS", bound: !!env.VEC_PROJECTS },
    { index: "VECTORIZE_ENTITIES", bound: !!env.VECTORIZE_ENTITIES },
  ];
}

// ---------- errors ---------------------------------------------------------

export async function collectRecentErrors(env: Env, limit = 100): Promise<ErrorSignature[]> {
  const rows = await safeQuery(async () => {
    const r = await env.DB.prepare(
      `SELECT code, kind, COALESCE(step, url, 'unknown') AS route,
              message, created_at
         FROM error_log
        WHERE created_at >= datetime('now','-1 day')
        ORDER BY created_at DESC
        LIMIT 1000`,
    ).all<{ code: string; kind: string; route: string; message: string; created_at: string }>();
    return r.results ?? [];
  }, [] as Array<{ code: string; kind: string; route: string; message: string; created_at: string }>);

  // Group by (code, normalized first line of message).
  const groups = new Map<string, ErrorSignature>();
  for (const r of rows) {
    const firstLine = (r.message ?? "").split("\n")[0].slice(0, 200);
    const normalized = firstLine.replace(/\d+/g, "#").replace(/0x[0-9a-f]+/gi, "#hex");
    const sig = `${r.code}|${normalized}`;
    const existing = groups.get(sig);
    if (existing) {
      existing.count++;
      if (r.created_at > existing.last_seen) existing.last_seen = r.created_at;
    } else {
      groups.set(sig, {
        signature: sig,
        count: 1,
        last_seen: r.created_at,
        sample_code: r.code,
        sample_message: firstLine,
        sample_route: r.route,
      });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export async function collectErrorRatePerMin(env: Env): Promise<number> {
  const r = await safeQuery(async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM error_log
        WHERE created_at >= datetime('now','-1 minute')`,
    ).first<{ n: number | null }>();
    return row;
  }, null as { n: number | null } | null);
  return Number(r?.n ?? 0);
}

// ---------- crons ----------------------------------------------------------

const KNOWN_CRONS: ReadonlyArray<{ name: string; cron_expr: string }> = [
  { name: "hourly dispatcher", cron_expr: "0 * * * *" },
  { name: "nightly consolidated", cron_expr: "15 3 * * *" },
];

export async function collectCronStatus(env: Env): Promise<CronStatusRow[]> {
  // Each cron prints `console.log` lines but the durable signal is in
  // workflow_step_log / ops_audit. We surface "last_run" as the latest
  // ops_audit row whose action starts with the cron's marker, falling
  // back to null when not yet observed.
  const out: CronStatusRow[] = [];
  for (const c of KNOWN_CRONS) {
    out.push({
      name: c.name,
      cron_expr: c.cron_expr,
      last_run: await lastCronRun(env, c.cron_expr),
      status: null,
      next_run_est: null,
    });
  }
  return out;
}

async function lastCronRun(env: Env, cronExpr: string): Promise<string | null> {
  // We mark cron ticks by inserting into health_snapshots with metric
  // `cron.tick.<cron_expr>` from scheduled.ts.
  const r = await safeQuery(async () => {
    const row = await env.DB.prepare(
      `SELECT MAX(bucket_start) AS t FROM health_snapshots
        WHERE metric_name = ?`,
    ).bind(`cron.tick.${cronExpr}`).first<{ t: string | null }>();
    return row;
  }, null as { t: string | null } | null);
  return r?.t ?? null;
}

// ---------- external APIs --------------------------------------------------

export async function collectExternalApis(env: Env, apiNames: string[]): Promise<ExternalApiCard[]> {
  const out: ExternalApiCard[] = [];
  for (const name of apiNames) {
    const latest = await safeQuery(async () => {
      const r = await env.DB.prepare(
        `SELECT api_name, probed_at, ok, latency_ms, rate_limit_remaining, error, configured
           FROM external_api_probes
          WHERE api_name = ?
          ORDER BY probed_at DESC
          LIMIT 1`,
      ).bind(name).first<{
        api_name: string; probed_at: string; ok: number; latency_ms: number | null;
        rate_limit_remaining: number | null; error: string | null; configured: number;
      }>();
      return r;
    }, null as {
      api_name: string; probed_at: string; ok: number; latency_ms: number | null;
      rate_limit_remaining: number | null; error: string | null; configured: number;
    } | null);
    const window = await safeQuery(async () => {
      const r = await env.DB.prepare(
        `SELECT
            SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS ok,
            COUNT(*) AS total,
            MAX(CASE WHEN ok=1 THEN probed_at END) AS last_success
           FROM external_api_probes
          WHERE api_name = ?
            AND probed_at >= datetime('now','-1 day')`,
      ).bind(name).first<{ ok: number | null; total: number | null; last_success: string | null }>();
      return r;
    }, null as { ok: number | null; total: number | null; last_success: string | null } | null);
    const total = Number(window?.total ?? 0);
    const okN = Number(window?.ok ?? 0);
    out.push({
      api_name: name,
      configured: latest?.configured ?? 1,
      last_success: window?.last_success ?? null,
      last_probe: latest?.probed_at ?? null,
      success_rate_24h: total > 0 ? Math.round((okN / total) * 1000) / 10 : null,
      rate_limit_remaining: latest?.rate_limit_remaining ?? null,
      last_error: latest?.ok === 0 ? latest?.error ?? null : null,
    });
  }
  return out;
}

// Re-export current time helper for tests.
export const _now = nowIso;
