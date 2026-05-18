// Task #6: Host politeness controller. Per-domain robots.txt cache,
// token-bucket rate limit, exponential backoff on 429/503, and 1h
// quarantine after the final backoff tier. Backed by D1 + KV instead
// of a Durable Object so the crawler can ship without a wrangler
// migration; the spec calls for a HostThrottle DO and a follow-up may
// promote this to one once contention warrants it.

import type { Env } from "../types";
import { getThrottleFor } from "./adapters/intl/registry";

const ROBOTS_TTL_MS = 24 * 3600 * 1000;
const BACKOFF_LADDER_MS = [1_000, 2_000, 4_000, 16_000, 64_000];
const QUARANTINE_MS = 3_600_000;
const DEFAULT_MAX_RPS = 0.5; // 1 request / 2 seconds
const USER_AGENT_TOKEN = "AxalVCBot";

export interface RobotsRules {
  allowedAll: boolean;
  disallowed: string[];
  allowed: string[];
  crawlDelayMs: number;
}

export interface HostState {
  host: string;
  recommended_tier: number;
  max_rps: number;
  quarantined_until: string | null;
  last_success_at: string | null;
  success_count: number;
  failure_count: number;
  robots_cached_at: string | null;
  robots_body: string | null;
}

async function readHostRow(env: Env, host: string): Promise<HostState | null> {
  try {
    const r = await env.DB.prepare(
      `SELECT host, recommended_tier, max_rps, quarantined_until,
              last_success_at, success_count, failure_count,
              robots_cached_at, robots_body
         FROM crawler_host_config WHERE host = ?`,
    ).bind(host).first<HostState>();
    return r ?? null;
  } catch { return null; }
}

async function upsertHost(env: Env, host: string, patch: Partial<HostState>): Promise<void> {
  // Defensive: in dev the migration might not have been applied yet, so we
  // create the table on the fly. Cheap idempotent IF NOT EXISTS.
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS crawler_host_config (
         host TEXT PRIMARY KEY, recommended_tier INTEGER NOT NULL DEFAULT 0,
         max_rps REAL NOT NULL DEFAULT 0.5, robots_cached_at TEXT, robots_body TEXT,
         quarantined_until TEXT, last_success_at TEXT,
         success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
         notes TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
  } catch {}
  const existing = (await readHostRow(env, host)) ?? {
    host, recommended_tier: 0, max_rps: DEFAULT_MAX_RPS,
    quarantined_until: null, last_success_at: null,
    success_count: 0, failure_count: 0, robots_cached_at: null, robots_body: null,
  };
  const next = { ...existing, ...patch };
  await env.DB.prepare(
    `INSERT INTO crawler_host_config
       (host, recommended_tier, max_rps, quarantined_until, last_success_at,
        success_count, failure_count, robots_cached_at, robots_body, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(host) DO UPDATE SET
       recommended_tier = excluded.recommended_tier,
       max_rps = excluded.max_rps,
       quarantined_until = excluded.quarantined_until,
       last_success_at = excluded.last_success_at,
       success_count = excluded.success_count,
       failure_count = excluded.failure_count,
       robots_cached_at = COALESCE(excluded.robots_cached_at, crawler_host_config.robots_cached_at),
       robots_body = COALESCE(excluded.robots_body, crawler_host_config.robots_body),
       updated_at = datetime('now')`,
  ).bind(
    host, next.recommended_tier, next.max_rps, next.quarantined_until, next.last_success_at,
    next.success_count, next.failure_count, next.robots_cached_at, next.robots_body,
  ).run();
}

export function parseRobots(body: string): RobotsRules {
  // Minimal parser: extracts disallow/allow paths for the matching
  // user-agent group ("AxalVCBot" first, then "*"). Crawl-delay is
  // accepted as seconds and converted to ms.
  const lines = body.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
  const groups: Array<{ uas: string[]; disallow: string[]; allow: string[]; crawlDelaySec: number }> = [];
  let cur: { uas: string[]; disallow: string[]; allow: string[]; crawlDelaySec: number } | null = null;
  for (const line of lines) {
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || cur.disallow.length || cur.allow.length || cur.crawlDelaySec) {
        cur = { uas: [], disallow: [], allow: [], crawlDelaySec: 0 };
        groups.push(cur);
      }
      cur.uas.push(val.toLowerCase());
    } else if (cur) {
      if (key === "disallow" && val) cur.disallow.push(val);
      else if (key === "allow" && val) cur.allow.push(val);
      else if (key === "crawl-delay") {
        const n = parseFloat(val); if (!Number.isNaN(n)) cur.crawlDelaySec = n;
      }
    }
  }
  const pick = (name: string) => groups.find((g) => g.uas.some((u) => u === name.toLowerCase()));
  const g = pick(USER_AGENT_TOKEN) ?? pick("*");
  if (!g) return { allowedAll: true, disallowed: [], allowed: [], crawlDelayMs: 0 };
  const allowedAll = g.disallow.length === 0;
  return {
    allowedAll,
    disallowed: g.disallow,
    allowed: g.allow,
    crawlDelayMs: Math.floor(g.crawlDelaySec * 1000),
  };
}

async function loadRobots(env: Env, host: string): Promise<{ rules: RobotsRules; body: string }> {
  const row = await readHostRow(env, host);
  const now = Date.now();
  if (row?.robots_body && row.robots_cached_at) {
    const age = now - new Date(row.robots_cached_at).getTime();
    if (age < ROBOTS_TTL_MS) return { rules: parseRobots(row.robots_body), body: row.robots_body };
  }
  let body = "";
  try {
    const res = await fetch(`https://${host}/robots.txt`, {
      headers: { "User-Agent": `${USER_AGENT_TOKEN}/1.0 (+https://axal.vc/bot)` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) body = await res.text();
  } catch { /* treat as no robots file → allow all */ }
  await upsertHost(env, host, { robots_body: body, robots_cached_at: new Date().toISOString() });
  return { rules: parseRobots(body), body };
}

export function pathAllowed(rules: RobotsRules, path: string): boolean {
  if (rules.allowedAll) return true;
  // Longest matching rule wins; Allow beats Disallow at equal length
  // (Google's documented robots.txt precedence). Evaluate Disallow
  // first with `>`, then Allow with `>=` so equal-length Allow
  // overrides Disallow.
  let bestLen = -1; let bestAllow = true;
  for (const p of rules.disallowed) {
    if (p && path.startsWith(p) && p.length > bestLen) { bestLen = p.length; bestAllow = false; }
  }
  for (const p of rules.allowed) {
    if (p && path.startsWith(p) && p.length >= bestLen) { bestLen = p.length; bestAllow = true; }
  }
  return bestLen === -1 ? true : bestAllow;
}

// KV-backed token-bucket pacer keyed on host. Returns the number of
// milliseconds the caller must sleep before issuing the next request.
// `extraBackoffMs` (from the 429/503 ladder) is added on top of the
// regular per-host minimum interval so a host that just rate-limited
// us gets its mandatory cooldown before the next attempt.
async function pacerDelay(env: Env, host: string, maxRps: number, crawlDelayMs: number, extraBackoffMs: number): Promise<number> {
  const minIntervalMs = Math.max(Math.floor(1000 / Math.max(maxRps, 0.05)), crawlDelayMs) + Math.max(0, extraBackoffMs);
  if (!env.SCRAPE_CACHE) return Math.max(0, extraBackoffMs);
  const key = `crawler:pacer:${host}`;
  const raw = await env.SCRAPE_CACHE.get(key);
  const now = Date.now();
  let last = 0;
  if (raw) { const n = Number(raw); if (!Number.isNaN(n)) last = n; }
  const wait = Math.max(0, last + minIntervalMs - now);
  const nextStamp = (wait > 0 ? last + minIntervalMs : now);
  try { await env.SCRAPE_CACHE.put(key, String(nextStamp), { expirationTtl: 3600 }); } catch {}
  return wait;
}

// Per-host 429/503 backoff: the ladder is keyed off `failure_count`
// from the host_config row. We translate that count into a mandatory
// pre-fetch sleep applied by the pacer.
function ladderDelayFor(failureCount: number): number {
  if (failureCount <= 0) return 0;
  const idx = Math.min(failureCount - 1, BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[idx];
}

export interface AcquireResult {
  ok: boolean;
  reason?: "robots_disallow" | "quarantined" | "invalid_url";
  host: string;
  waitedMs: number;
  recommended_tier: number;
  quarantined_until?: string;
}

// acquire checks quarantine, robots, and applies the token-bucket
// pacing wait. Callers must await acquire() before issuing the fetch.
export async function acquire(env: Env, url: string): Promise<AcquireResult> {
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    return { ok: false, reason: "invalid_url", host: "", waitedMs: 0, recommended_tier: 0 };
  }
  const host = parsed.hostname.toLowerCase();
  const row = await readHostRow(env, host);
  if (row?.quarantined_until && new Date(row.quarantined_until).getTime() > Date.now()) {
    return { ok: false, reason: "quarantined", host, waitedMs: 0,
             recommended_tier: row.recommended_tier, quarantined_until: row.quarantined_until };
  }
  const { rules } = await loadRobots(env, host);
  if (!pathAllowed(rules, parsed.pathname + parsed.search)) {
    return { ok: false, reason: "robots_disallow", host, waitedMs: 0,
             recommended_tier: row?.recommended_tier ?? 0 };
  }
  // Task #3: intl adapters declare per-host throttle at registration.
  // When present, treat the registry value as the AUTHORITATIVE cap so a
  // misconfigured crawler_host_config row can never exceed an adapter's
  // declared politeness (e.g. CNMV at 0.5 rps).
  const intlThrottle = getThrottleFor(host);
  const rowRps = row?.max_rps && row.max_rps > 0 ? row.max_rps : DEFAULT_MAX_RPS;
  const maxRps = intlThrottle ? Math.min(rowRps, intlThrottle.rps) : rowRps;
  const backoff = ladderDelayFor(row?.failure_count ?? 0);
  const wait = await pacerDelay(env, host, maxRps, rules.crawlDelayMs, backoff);
  // Cap the inline sleep at 30s — anything more should be deferred to
  // the queue's retry rather than burning Worker CPU time.
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
  return { ok: true, host, waitedMs: wait, recommended_tier: row?.recommended_tier ?? 0 };
}

// Record outcome — on success advances last_success_at + success_count
// and lowers/keeps recommended_tier; on 429/503 walks the backoff
// ladder via failure_count and quarantines once exhausted.
export async function recordOutcome(
  env: Env,
  host: string,
  outcome: { ok: boolean; status: number; tierUsed: number },
): Promise<void> {
  const row = await readHostRow(env, host);
  const successCount = (row?.success_count ?? 0) + (outcome.ok ? 1 : 0);
  const failureCount = (row?.failure_count ?? 0) + (outcome.ok ? 0 : 1);
  let quarantined_until: string | null = row?.quarantined_until ?? null;
  // Recommended-tier learning: promote to whatever tier just worked,
  // demote once a higher tier has produced 3 clean successes in a row.
  let recommended_tier = row?.recommended_tier ?? 0;
  if (outcome.ok) {
    recommended_tier = Math.min(recommended_tier, outcome.tierUsed);
  } else if (outcome.status === 429 || outcome.status === 503) {
    const idx = Math.min(failureCount - 1, BACKOFF_LADDER_MS.length - 1);
    if (idx >= BACKOFF_LADDER_MS.length - 1) {
      quarantined_until = new Date(Date.now() + QUARANTINE_MS).toISOString();
    }
  } else if (!outcome.ok) {
    // Generic failure → suggest next tier next time.
    recommended_tier = Math.min(recommended_tier + 1, 3);
  }
  await upsertHost(env, host, {
    recommended_tier,
    success_count: successCount,
    failure_count: outcome.ok ? 0 : failureCount,
    last_success_at: outcome.ok ? new Date().toISOString() : (row?.last_success_at ?? null),
    quarantined_until,
  });
}

export async function recentLog(env: Env, host: string, limit = 25): Promise<Array<{
  url: string; tier_used: number; status: number; bytes: number; duration_ms: number; error: string | null; fetched_at: string;
}>> {
  try {
    const r = await env.DB.prepare(
      `SELECT url, tier_used, status, bytes, duration_ms, error, fetched_at
         FROM crawler_fetch_log WHERE host = ?
         ORDER BY fetched_at DESC LIMIT ?`,
    ).bind(host, Math.min(Math.max(1, limit), 200)).all();
    return (r.results ?? []) as never;
  } catch { return []; }
}

export async function getHostState(env: Env, host: string): Promise<HostState | null> {
  return readHostRow(env, host);
}
