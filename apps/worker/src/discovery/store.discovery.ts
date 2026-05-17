// Task #2: discovered_urls / link_graph / crawl_frontier persistence.
//
// All writes are upserts on `url_canonical` so re-running discovery
// across overlapping seeds quietly merges into the existing rows.

import type { Env } from "../types";
import { canonicalizeUrl, isObviousReject } from "./canonical";

export interface DiscoveredUrlInput {
  url: string;
  discoveredFromUrl?: string | null;
  discoveredFromId?: string | null;
  discoveryMethod: string;
  depth: number;
  linkText?: string | null;
  linkContext?: string | null;
  likelyKind?: string | null;
  expectedYieldScore?: number;
  status?: "new" | "queued" | "crawled" | "rejected" | "promoted";
  rejectedReason?: string | null;
  jobId?: string | null;
}

export interface DiscoveredUrlRow {
  id: string;
  url: string;
  url_canonical: string;
  host: string;
  discovery_method: string;
  depth: number;
  status: string;
  expected_yield_score: number;
  likely_kind: string | null;
  link_text: string | null;
  link_context: string | null;
  first_seen: string;
  last_seen: string;
  last_crawled_at: string | null;
  discovered_from_id: string | null;
  rejected_reason: string | null;
}

/**
 * Upsert a discovered URL. Returns the row id + whether the row is new
 * + the canonical form so the caller can wire an edge in link_graph.
 *
 * Auto-rejects obvious garbage (mailto:, javascript:, static assets,
 * twitter share intents). Callers don't need to filter ahead of time.
 */
export async function upsertDiscoveredUrl(env: Env, input: DiscoveredUrlInput): Promise<{ id: string; created: boolean; canonical: string; host: string; rejected: boolean } | null> {
  const c = canonicalizeUrl(input.url);
  if (!c) return null;
  const reject = isObviousReject(c);
  const status = reject ? "rejected" : (input.status ?? "new");
  const rejected_reason = reject ?? input.rejectedReason ?? null;

  const existing = await env.DB.prepare(
    `SELECT id, status, expected_yield_score FROM discovered_urls WHERE url_canonical = ?`,
  ).bind(c.canonical).first<{ id: string; status: string; expected_yield_score: number }>();

  if (existing) {
    // Bump last_seen + keep the higher yield score we've ever predicted.
    // CRITICAL: respect the persisted status. A URL previously marked
    // `rejected` or `promoted` by an operator (or by a prior obvious-
    // reject check) must NOT silently become eligible for queueing again.
    const newYield = Math.max(existing.expected_yield_score ?? 0, input.expectedYieldScore ?? 0);
    // If the row was previously stored without a rejected verdict but
    // now matches an obvious-reject rule (e.g. our reject heuristics
    // improved between runs), persist the rejected state explicitly so
    // DB queries / dashboards stop showing this URL as eligible.
    const persistReject = reject && existing.status === "new";
    await env.DB.prepare(
      `UPDATE discovered_urls SET
         last_seen = CURRENT_TIMESTAMP,
         expected_yield_score = ?,
         link_text = COALESCE(link_text, ?),
         link_context = COALESCE(link_context, ?),
         likely_kind = COALESCE(likely_kind, ?),
         status = CASE WHEN ? = 1 THEN 'rejected' ELSE status END,
         rejected_reason = CASE WHEN ? = 1 THEN ? ELSE rejected_reason END
       WHERE id = ?`,
    ).bind(
      newYield, input.linkText ?? null, input.linkContext ?? null, input.likelyKind ?? null,
      persistReject ? 1 : 0, persistReject ? 1 : 0, rejected_reason, existing.id,
    ).run();
    const terminal = existing.status === "rejected" || existing.status === "promoted" || existing.status === "crawled";
    return {
      id: existing.id,
      created: false,
      canonical: c.canonical,
      host: c.host,
      // Mark `rejected` so the orchestrator skips enqueue for terminal
      // states OR for newly obvious-reject inputs.
      rejected: status === "rejected" || terminal,
    };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO discovered_urls
       (id, url, url_canonical, host, discovered_from_url, discovered_from_id,
        discovery_method, depth, link_text, link_context, likely_kind,
        expected_yield_score, status, rejected_reason, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, c.url, c.canonical, c.host,
    input.discoveredFromUrl ?? null, input.discoveredFromId ?? null,
    input.discoveryMethod, input.depth,
    (input.linkText ?? "").slice(0, 400) || null,
    (input.linkContext ?? "").slice(0, 800) || null,
    input.likelyKind ?? null,
    input.expectedYieldScore ?? 0,
    status, rejected_reason, input.jobId ?? null,
  ).run();
  return { id, created: true, canonical: c.canonical, host: c.host, rejected: status === "rejected" };
}

export async function insertLinkEdge(env: Env, srcId: string, dstId: string, linkKind: string, weight = 1.0): Promise<void> {
  if (!srcId || !dstId || srcId === dstId) return;
  try {
    await env.DB.prepare(
      `INSERT INTO link_graph (src_url_id, dst_url_id, link_kind, weight)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(src_url_id, dst_url_id) DO UPDATE SET
         link_kind = COALESCE(link_graph.link_kind, excluded.link_kind),
         weight = MAX(link_graph.weight, excluded.weight)`,
    ).bind(srcId, dstId, linkKind, weight).run();
  } catch (e) {
    console.warn("insertLinkEdge failed", (e as Error).message);
  }
}

export async function enqueueFrontier(env: Env, urlId: string, priority: number, runId?: string | null): Promise<{ inserted: boolean }> {
  // Two-step so we can distinguish "this URL is new on the frontier"
  // from "we just bumped an existing row's priority". The first INSERT
  // OR IGNORE reports meta.changes=1 only on a real insert; on conflict
  // we then upgrade the priority/run_id without affecting that signal.
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO crawl_frontier (url_id, priority, scheduled_at, run_id)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)`,
  ).bind(urlId, priority, runId ?? null).run();
  const inserted = !!((ins as { meta?: { changes?: number } }).meta?.changes);
  if (!inserted) {
    await env.DB.prepare(
      `UPDATE crawl_frontier
          SET priority = MAX(priority, ?),
              run_id   = COALESCE(run_id, ?)
        WHERE url_id = ?`,
    ).bind(priority, runId ?? null, urlId).run();
  }
  await env.DB.prepare(`UPDATE discovered_urls SET status = 'queued' WHERE id = ? AND status = 'new'`).bind(urlId).run();
  return { inserted };
}

export async function popFrontier(env: Env, limit: number, runId?: string | null): Promise<Array<{ url_id: string; url: string; host: string; priority: number; depth: number; attempts: number; run_id: string | null }>> {
  // Diversity bias: dedupe by host so a single noisy host doesn't take
  // the whole batch. Cheap implementation — take the top-3 per host
  // then re-order globally. When `runId` is provided we scope the queue
  // to that run so dashboard "Crawl frontier" follows the seed's run
  // context end-to-end.
  const runFilter = runId ? "AND cf.run_id = ?" : "";
  const stmt = env.DB.prepare(
    `SELECT cf.url_id, du.url, du.host, cf.priority, du.depth, cf.attempts, cf.run_id
       FROM crawl_frontier cf
       JOIN discovered_urls du ON du.id = cf.url_id
      WHERE (cf.next_attempt_at IS NULL OR datetime(cf.next_attempt_at) <= datetime('now'))
        ${runFilter}
      ORDER BY cf.priority DESC, cf.scheduled_at ASC
      LIMIT ?`,
  );
  const bound = runId ? stmt.bind(runId, Math.max(1, Math.min(limit * 4, 200))) : stmt.bind(Math.max(1, Math.min(limit * 4, 200)));
  const r = await bound.all<{ url_id: string; url: string; host: string; priority: number; depth: number; attempts: number; run_id: string | null }>();
  const rows = r.results ?? [];
  const perHost: Record<string, number> = {};
  const picked: typeof rows = [];
  for (const row of rows) {
    perHost[row.host] = (perHost[row.host] ?? 0) + 1;
    if (perHost[row.host] > 3) continue;
    picked.push(row);
    if (picked.length >= limit) break;
  }
  // Atomically claim each picked row by pushing its next_attempt_at into
  // the near future. A concurrent crawl run won't see them as eligible
  // until 10 minutes pass, so duplicate work is avoided even without a
  // real transaction (D1 lacks SELECT … FOR UPDATE). Rows we successfully
  // claim are returned; rows already claimed by someone else (the UPDATE
  // matched 0 rows because next_attempt_at moved) are filtered out.
  const claimed: typeof rows = [];
  for (const row of picked) {
    const upd = await env.DB.prepare(
      `UPDATE crawl_frontier
          SET next_attempt_at = datetime('now', '+10 minutes')
        WHERE url_id = ?
          AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))`,
    ).bind(row.url_id).run();
    // D1's RunResult exposes meta.changes; only treat the row as claimed
    // when we actually moved the lock forward.
    const meta = (upd as { meta?: { changes?: number } }).meta;
    if (meta?.changes && meta.changes > 0) claimed.push(row);
  }
  return claimed;
}

export async function removeFromFrontier(env: Env, urlId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM crawl_frontier WHERE url_id = ?`).bind(urlId).run();
}

export async function markCrawled(env: Env, urlId: string, entityIdsFound: string[]): Promise<void> {
  await env.DB.prepare(
    `UPDATE discovered_urls SET status = 'crawled', last_crawled_at = CURRENT_TIMESTAMP,
       entity_ids_found_json = ? WHERE id = ?`,
  ).bind(entityIdsFound.length ? JSON.stringify(entityIdsFound) : null, urlId).run();
  await removeFromFrontier(env, urlId);
}

export async function markFrontierError(env: Env, urlId: string, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE crawl_frontier SET attempts = attempts + 1,
       last_error = ?,
       next_attempt_at = datetime('now', '+10 minutes')
     WHERE url_id = ?`,
  ).bind(error.slice(0, 400), urlId).run();
}

/**
 * Soft deferral for *non-error* pacing events (e.g. host rate-limit
 * gate). We do NOT bump `attempts` and we use a short retry window so
 * the URL re-enters the frontier within seconds rather than 10 minutes.
 * This separates "we deferred you because of politeness" from "you
 * actually failed" for clearer operator telemetry + better throughput.
 */
export async function deferFrontier(env: Env, urlId: string, reason: string, seconds = 10): Promise<void> {
  await env.DB.prepare(
    `UPDATE crawl_frontier SET
       last_error = ?,
       next_attempt_at = datetime('now', '+' || ? || ' seconds')
     WHERE url_id = ?`,
  ).bind(reason.slice(0, 400), seconds, urlId).run();
}

export async function getDiscoveredUrl(env: Env, id: string): Promise<DiscoveredUrlRow | null> {
  return await env.DB.prepare(`SELECT * FROM discovered_urls WHERE id = ?`).bind(id).first<DiscoveredUrlRow>();
}

/** Run-wide host counter. Atomic upsert + read in one round trip. */
export async function bumpRunHostCount(env: Env, runId: string, host: string, delta = 1): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO discovery_run_hosts (run_id, host, n) VALUES (?, ?, ?)
       ON CONFLICT(run_id, host) DO UPDATE SET n = discovery_run_hosts.n + excluded.n`,
  ).bind(runId, host, delta).run();
  const r = await env.DB.prepare(
    `SELECT n FROM discovery_run_hosts WHERE run_id = ? AND host = ?`,
  ).bind(runId, host).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getRunHostCount(env: Env, runId: string, host: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT n FROM discovery_run_hosts WHERE run_id = ? AND host = ?`,
  ).bind(runId, host).first<{ n: number }>();
  return r?.n ?? 0;
}
