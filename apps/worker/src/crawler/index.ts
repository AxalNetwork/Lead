// Task #6: In-house crawler engine — public entry. Wires the fetcher,
// extractor, and frontier enqueue path together so route handlers and
// future per-type workflows share one code path.

export { crawlerFetch, CRAWLER_UA, type FetcherResult, type CrawlerTier } from "./fetcher";
export { acquire, recordOutcome, recentLog, getHostState, parseRobots, pathAllowed,
         type RobotsRules, type HostState } from "./hostThrottle";
export { extractCandidates, type ExtractionResult, type ExtractedCandidate } from "./extractor";

import type { Env } from "../types";
import { crawlerFetch } from "./fetcher";
import { extractCandidates, type ExtractionResult } from "./extractor";

export interface CrawlerPreview {
  ok: boolean;
  fetch: { status: number; tier_used: number; duration_ms: number; bytes: number; error: string | null };
  extraction: ExtractionResult | null;
  error: string | null;
}

// Preview = fetch + extract without committing. Used by
// POST /api/crawler/fetch. The "commit" path lives behind the
// PredicateRouter and is invoked from per-profile-type workflows
// (separate task).
export async function previewUrl(
  env: Env, url: string, opts: { profileTypeHint?: string } = {},
): Promise<CrawlerPreview> {
  const r = await crawlerFetch(env, url);
  if (!r.ok) {
    return {
      ok: false,
      fetch: { status: r.status, tier_used: r.tier_used, duration_ms: r.duration_ms, bytes: r.bytes, error: r.error },
      extraction: null,
      error: r.error ?? "fetch_failed",
    };
  }
  const ext = await extractCandidates(env, r.finalUrl, r.html, opts);
  return {
    ok: true,
    fetch: { status: r.status, tier_used: r.tier_used, duration_ms: r.duration_ms, bytes: r.bytes, error: null },
    extraction: ext,
    error: null,
  };
}

export interface EnqueueResult { ok: true; id: number; url: string; host: string; status: "queued" | "duplicate" }

export async function enqueueFrontier(
  env: Env, url: string, opts: { profileTypeHint?: string; priority?: number; byEmail?: string | null } = {},
): Promise<EnqueueResult> {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch { throw new Error("invalid_url"); }
  // Defensive table creation in dev.
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS crawler_frontier (
         id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
         profile_type_hint TEXT, priority INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'queued', enqueued_by_email TEXT,
         enqueued_at TEXT NOT NULL DEFAULT (datetime('now')), processed_at TEXT)`,
    ).run();
  } catch {}
  const existing = await env.DB.prepare(
    `SELECT id FROM crawler_frontier WHERE url = ?`,
  ).bind(url).first<{ id: number }>();
  if (existing) return { ok: true, id: existing.id, url, host, status: "duplicate" };
  const r = await env.DB.prepare(
    `INSERT INTO crawler_frontier (url, host, profile_type_hint, priority, enqueued_by_email)
     VALUES (?,?,?,?,?)`,
  ).bind(url, host, opts.profileTypeHint ?? null, opts.priority ?? 0, opts.byEmail ?? null).run();
  return { ok: true, id: Number(r.meta?.last_row_id ?? 0), url, host, status: "queued" };
}
