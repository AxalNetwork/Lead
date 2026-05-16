// Task #3: daily watchlist cache refresh.
//
// We don't store full watchlists in D1 — OpenSanctions et al. publish
// daily-updated bulk JSON we can mirror to R2 (≈10–80 MB) and record a
// metadata row in `dd_watchlist_cache`. The cache is informational
// today (the per-entity scan calls OpenSanctions' match endpoint
// directly), but having the snapshot in R2 means we can audit "what
// did the SDN list say on this date" later.

import type { Env } from "../types";

interface SourceDef {
  provider: string;
  list_name: string;
  url: string;
  // Optional: count records by JSONPath-ish dotted accessor.
  countPath?: string;
}

const SOURCES: SourceDef[] = [
  // OpenSanctions consolidated entity index (all datasets). Big but
  // cached once per day with R2 lifecycle TTL.
  { provider: "opensanctions", list_name: "consolidated", url: "https://data.opensanctions.org/datasets/latest/default/index.json" },
  // OFAC SDN — JSON mirror via OpenSanctions
  { provider: "ofac", list_name: "sdn", url: "https://data.opensanctions.org/datasets/latest/us_ofac_sdn/index.json" },
  // EU consolidated sanctions
  { provider: "eu", list_name: "consolidated", url: "https://data.opensanctions.org/datasets/latest/eu_fsf/index.json" },
  // UN Security Council consolidated
  { provider: "un", list_name: "consolidated", url: "https://data.opensanctions.org/datasets/latest/un_sc_sanctions/index.json" },
  // UK HMT consolidated
  { provider: "uk_hmt", list_name: "consolidated", url: "https://data.opensanctions.org/datasets/latest/gb_hmt_sanctions/index.json" },
  // INTERPOL Red Notices (mirrored via OpenSanctions).
  { provider: "interpol", list_name: "red_notices", url: "https://data.opensanctions.org/datasets/latest/interpol_red_notices/index.json" },
  // Politically Exposed Persons (Wikidata-derived global PEP set).
  { provider: "wd_peps", list_name: "global_peps", url: "https://data.opensanctions.org/datasets/latest/wd_peps/index.json" },
];

async function sha256Bytes(b: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", b);
  const arr = new Uint8Array(h);
  let s = ""; for (const x of arr) s += x.toString(16).padStart(2, "0"); return s;
}

export async function refreshWatchlistOne(env: Env, src: SourceDef): Promise<{ ok: boolean; record_count: number; error?: string }> {
  const t0 = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const r2Key = `dd-watchlists/${src.provider}/${today}.json`;
  try {
    const res = await fetch(src.url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const buf = await res.arrayBuffer();
    const hash = await sha256Bytes(buf);
    // Probe the JSON for entity count without fully parsing into memory.
    let count = 0;
    try {
      const text = new TextDecoder().decode(buf);
      const j = JSON.parse(text) as Record<string, unknown> & { entity_count?: number; things?: unknown[]; targets?: unknown[] };
      if (typeof j.entity_count === "number") count = j.entity_count;
      else if (Array.isArray(j.things)) count = j.things.length;
      else if (Array.isArray(j.targets)) count = j.targets.length;
    } catch { /* ok */ }
    if (env.RAW_HTML) {
      await env.RAW_HTML.put(r2Key, buf, { httpMetadata: { contentType: "application/json" } });
    }
    const duration_ms = Date.now() - t0;
    await env.DB.prepare(
      `INSERT INTO dd_watchlist_cache (provider, list_name, snapshot_date, record_count, content_hash, r2_key, source_url, fetched_at, duration_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(provider, list_name, snapshot_date) DO UPDATE SET
         record_count = excluded.record_count,
         content_hash = excluded.content_hash,
         r2_key = excluded.r2_key,
         fetched_at = excluded.fetched_at,
         duration_ms = excluded.duration_ms,
         ok = 1,
         error = NULL`,
    ).bind(src.provider, src.list_name, today, count, hash, r2Key, src.url, new Date().toISOString(), duration_ms).run();
    return { ok: true, record_count: count };
  } catch (e) {
    const msg = (e as Error).message;
    await env.DB.prepare(
      `INSERT INTO dd_watchlist_cache (provider, list_name, snapshot_date, record_count, source_url, fetched_at, duration_ms, ok, error)
       VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?)
       ON CONFLICT(provider, list_name, snapshot_date) DO UPDATE SET
         fetched_at = excluded.fetched_at,
         duration_ms = excluded.duration_ms,
         ok = 0,
         error = excluded.error`,
    ).bind(src.provider, src.list_name, today, src.url, new Date().toISOString(), Date.now() - t0, msg).run();
    return { ok: false, record_count: 0, error: msg };
  }
}

export async function refreshAllWatchlists(env: Env): Promise<{ refreshed: number; failed: number; details: Array<{ provider: string; list_name: string; ok: boolean; record_count: number; error?: string }> }> {
  const details: Array<{ provider: string; list_name: string; ok: boolean; record_count: number; error?: string }> = [];
  let refreshed = 0, failed = 0;
  for (const src of SOURCES) {
    const r = await refreshWatchlistOne(env, src);
    details.push({ provider: src.provider, list_name: src.list_name, ...r });
    if (r.ok) refreshed += 1; else failed += 1;
  }
  return { refreshed, failed, details };
}

export async function batchScanDueEntities(env: Env, opts: { limit?: number; staleDays?: number } = {}): Promise<{ scanned: number; failed: number }> {
  const limit = opts.limit ?? 100;
  const stale = opts.staleDays ?? 7;
  // Prioritize entities that have never been scanned, then oldest scan first.
  const r = await env.DB.prepare(
    `SELECT e.id, e.kind, e.name
       FROM entities e
       LEFT JOIN entity_risk_scores r ON r.entity_id = e.id
      WHERE r.entity_id IS NULL OR datetime(r.last_scan_at) < datetime('now', ?)
      ORDER BY r.last_scan_at IS NULL DESC, r.last_scan_at ASC
      LIMIT ?`,
  ).bind(`-${stale} days`, limit).all<{ id: number; kind: string; name: string }>();
  let scanned = 0, failed = 0;
  for (const row of r.results ?? []) {
    try {
      const { scanEntity, loadEntityForScan } = await import("./scan");
      const ent = await loadEntityForScan(env, row.id);
      if (!ent) continue;
      await scanEntity(env, ent, { trigger: "cron" });
      scanned += 1;
    } catch (e) {
      console.warn("batchScanDueEntities entity failed", row.id, (e as Error).message);
      failed += 1;
    }
  }
  return { scanned, failed };
}
