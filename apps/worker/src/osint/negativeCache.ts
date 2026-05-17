// Negative-cache helpers — both KV (fast) and DB (durable).
//
// Probe hits cache as misses for 30 days. A second probe of the same
// (entity, platform, handle) short-circuits without spending a fetch.
// Both stores are checked / written best-effort; KV is the hot path.

import type { Env } from "../types";

const KV_PREFIX = "osint:miss";
const DEFAULT_TTL = 30 * 24 * 3600; // 30 days

export function kvMissKey(platform: string, handle: string): string {
  return `${KV_PREFIX}:${platform}:${handle.toLowerCase()}`;
}

export async function isNegativeCached(
  env: Env,
  entityId: string,
  platform: string,
  handle: string,
): Promise<boolean> {
  try {
    const kv = await env.SCRAPE_CACHE.get(kvMissKey(platform, handle));
    if (kv) return true;
  } catch { /* ignore */ }
  try {
    const r = await env.DB.prepare(
      `SELECT checked_at, ttl_seconds FROM osint_negative_cache
        WHERE entity_id = ? AND platform = ? AND handle_probe = ?`,
    ).bind(entityId, platform, handle.toLowerCase()).first<{ checked_at: string; ttl_seconds: number }>();
    if (!r) return false;
    const ageMs = Date.now() - Date.parse(r.checked_at);
    return ageMs < r.ttl_seconds * 1000;
  } catch {
    return false;
  }
}

export async function recordMiss(
  env: Env,
  entityId: string,
  platform: string,
  handle: string,
  reason: string,
  ttlSeconds: number = DEFAULT_TTL,
): Promise<void> {
  const h = handle.toLowerCase();
  try {
    await env.SCRAPE_CACHE.put(kvMissKey(platform, h), "1", { expirationTtl: ttlSeconds });
  } catch { /* ignore */ }
  try {
    await env.DB.prepare(
      `INSERT INTO osint_negative_cache (entity_id, platform, handle_probe, checked_at, ttl_seconds, reason)
        VALUES (?, ?, ?, datetime('now'), ?, ?)
        ON CONFLICT(entity_id, platform, handle_probe) DO UPDATE SET
          checked_at = excluded.checked_at,
          ttl_seconds = excluded.ttl_seconds,
          reason = excluded.reason`,
    ).bind(entityId, platform, h, ttlSeconds, reason.slice(0, 200)).run();
  } catch (e) {
    console.warn("osint negative cache write failed", (e as Error).message);
  }
}
