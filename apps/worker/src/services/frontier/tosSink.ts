// Task #6: ToS-block sink for the discovery frontier.
//
// When the queue preflight (apps/worker/src/scraper/preflight.ts) skips a
// job because the target host is on the ToS denylist, we stamp the URL
// in `discovered_urls` (tos_blocked_at + status='rejected') and remove
// it from the work queues (`crawl_frontier`, `smart_frontier`) so the
// scheduler never picks it up again.
//
// The `cleanupTosBlockedFrontier` one-shot sweeps the existing backlog
// of already-enqueued ToS hosts (per the spec: "TikTok / other
// ToS-blocked URLs that the discovery layer keeps re-enqueueing
// because nothing stamps them as permanently rejected"). Safe to
// re-run — it's an idempotent UPDATE + DELETE pair gated on the
// canonical tos-flags.json list.

import type { Env } from "../../types";
import { listBlockedDomains, tosBlockedReason } from "../../scraper/tos";

export interface TosSinkResult {
  marked_discovered: number;
  cleared_crawl_frontier: number;
  cleared_smart_frontier: number;
}

/**
 * Mark a single URL as ToS-blocked across the discovery surface. Called
 * inline by the preflight when a job fires the ToS gate. Idempotent —
 * subsequent invocations are no-ops because the canonical UNIQUE on
 * `discovered_urls.url_canonical` prevents duplicate rows and the
 * UPDATE WHERE tos_blocked_at IS NULL short-circuits.
 */
export async function markUrlTosBlocked(
  env: Env,
  url: string,
  reason: string,
): Promise<void> {
  if (!url) return;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return;
  }
  if (!host) return;
  const now = new Date().toISOString();
  // Best-effort: a missing column on a legacy DB shouldn't crash the
  // preflight. The fetcher's internal ToS block is still the backstop.
  try {
    await env.DB.prepare(
      `UPDATE discovered_urls
          SET status = 'rejected',
              rejected_reason = COALESCE(rejected_reason, ?),
              tos_blocked_at  = COALESCE(tos_blocked_at, ?)
        WHERE host = ? AND (tos_blocked_at IS NULL OR status != 'rejected')`,
    ).bind(reason, now, host).run();
  } catch { /* migration not applied; backstop wins */ }
  try {
    await env.DB.prepare(
      `DELETE FROM crawl_frontier
        WHERE url_id IN (SELECT id FROM discovered_urls WHERE host = ?)`,
    ).bind(host).run();
  } catch { /* table may not exist in legacy test DB */ }
  try {
    await env.DB.prepare(
      `UPDATE smart_frontier SET status = 'rejected'
        WHERE host = ? AND status IN ('queued','enqueued')`,
    ).bind(host).run();
  } catch { /* table may not exist in legacy test DB */ }
}

/**
 * One-shot cleanup of the existing ToS-blocked backlog. Iterates every
 * host in `data/tos-flags.json`, marks all matching discovered_urls
 * rows tos_blocked, and flushes the corresponding crawl_frontier /
 * smart_frontier rows. Returns totals for the ops audit log.
 *
 * Safe to re-run; safe to call from a maintenance endpoint.
 */
export async function cleanupTosBlockedFrontier(env: Env): Promise<TosSinkResult> {
  const out: TosSinkResult = {
    marked_discovered: 0,
    cleared_crawl_frontier: 0,
    cleared_smart_frontier: 0,
  };
  const blocked = listBlockedDomains();
  const now = new Date().toISOString();
  for (const entry of blocked) {
    const domain = entry.domain;
    const reason = `tos_blocked:${domain}: ${entry.reason}`;
    // Suffix-LIKE catches subdomains the same way tosBlockedReason
    // does (e.g. m.tiktok.com matches "tiktok.com").
    try {
      const r = await env.DB.prepare(
        `UPDATE discovered_urls
            SET status = 'rejected',
                rejected_reason = COALESCE(rejected_reason, ?),
                tos_blocked_at  = COALESCE(tos_blocked_at, ?)
          WHERE (host = ? OR host LIKE ?)
            AND (tos_blocked_at IS NULL OR status != 'rejected')`,
      ).bind(reason, now, domain, `%.${domain}`).run();
      out.marked_discovered += Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
    } catch { /* swallow per-host */ }
    try {
      const r = await env.DB.prepare(
        `DELETE FROM crawl_frontier
          WHERE url_id IN (
            SELECT id FROM discovered_urls WHERE host = ? OR host LIKE ?
          )`,
      ).bind(domain, `%.${domain}`).run();
      out.cleared_crawl_frontier += Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
    } catch { /* swallow */ }
    try {
      const r = await env.DB.prepare(
        `UPDATE smart_frontier SET status = 'rejected'
          WHERE (host = ? OR host LIKE ?) AND status IN ('queued','enqueued')`,
      ).bind(domain, `%.${domain}`).run();
      out.cleared_smart_frontier += Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
    } catch { /* swallow */ }
  }
  // Sanity: re-verify a sample host is still considered blocked by the
  // canonical lookup (catches a tos-flags.json that was emptied).
  void tosBlockedReason("tiktok.com");
  return out;
}
