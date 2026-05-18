// Task #3 (third-pass review fix): profile_type_id lookup from a source URL.
//
// Used by the discovery layer so that when `runCrawlFrontier` calls
// `expandFrontier` for a freshly crawled page, the emitted smart_frontier
// candidates carry the same profile_type as the seed that kicked off the
// crawl. Without this, every expansion was untyped (profile_type_id=NULL),
// which both undermined per-type fanout control and broke dedup before
// migration 344.

import type { Env } from "../../types";
import { canonicalizeUrl } from "../../discovery/canonical";

// Direct candidate-set match: tries the URL spelled multiple ways
// against `crawler_seeds.value`. Returns null on miss.
async function matchSeedByUrl(env: Env, url: string): Promise<string | null> {
  if (!url) return null;
  const candidates = new Set<string>([url]);
  const can = canonicalizeUrl(url);
  if (can) {
    candidates.add(can.url);
    candidates.add(can.canonical);
    candidates.add(can.url.endsWith("/") ? can.url.slice(0, -1) : can.url + "/");
  }
  const values = [...candidates];
  const placeholders = values.map(() => "?").join(",");
  try {
    const row = await env.DB.prepare(
      `SELECT profile_type_id FROM crawler_seeds
        WHERE seed_kind = 'url' AND value IN (${placeholders})
        LIMIT 1`,
    ).bind(...values).first<{ profile_type_id: string }>();
    return row?.profile_type_id ?? null;
  } catch (e) {
    console.warn("matchSeedByUrl failed", (e as Error).message);
    return null;
  }
}

// Resolves the originating seed's profile_type_id for a URL by walking
// the discovered_urls.discovered_from_url chain. Most crawled URLs are
// child links of a seed, so a direct match almost always misses — the
// lineage walk is how a descendant page inherits its seed's type.
//
// Bounded walk depth (10 hops) guards against pathological loops.
export async function lookupSeedProfileType(env: Env, url: string): Promise<string | null> {
  // 1. Direct hit: the URL itself is a registered seed.
  const direct = await matchSeedByUrl(env, url);
  if (direct) return direct;

  // 2. Walk the parent chain through discovered_urls.
  let cursor: string | null = url;
  const seen = new Set<string>();
  for (let hop = 0; hop < 10 && cursor; hop++) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    try {
      const can = canonicalizeUrl(cursor);
      const canon: string = can?.canonical ?? cursor;
      const row: { discovered_from_url: string | null } | null = await env.DB.prepare(
        `SELECT discovered_from_url FROM discovered_urls WHERE url_canonical = ? LIMIT 1`,
      ).bind(canon).first<{ discovered_from_url: string | null }>();
      const parent: string | null = row?.discovered_from_url ?? null;
      if (!parent) return null;
      const hit = await matchSeedByUrl(env, parent);
      if (hit) return hit;
      cursor = parent;
    } catch (e) {
      console.warn("lookupSeedProfileType walk failed", (e as Error).message);
      return null;
    }
  }
  return null;
}
