// Task #3: Hourly seed-sweep.
//
// Picks up to N enabled crawler_seeds whose refresh interval has elapsed
// and enqueues each onto the existing discovery pipeline:
//
//   * seed_kind = "url"                → DiscoverFromSeedWorkflow (or
//                                        runDiscoverFromSeed when no WF).
//   * seed_kind = "search_query"       → bootstrapEntity() → enqueue each
//                                        candidate URL as a seed.
//   * seed_kind = "directory_pattern"  → currently a no-op marker; touched
//                                        to last_crawled_at so it does
//                                        not block the sweep, dedicated
//                                        adapter is a follow-up.
//
// `last_crawled_at` is set to now() the moment the seed is enqueued so a
// second cron tick within the same hour does not re-enqueue it.

import type { Env } from "../../types";
import { canonicalizeUrl } from "../../discovery/canonical";
import { bootstrapEntity } from "../searchBootstrap";

export interface SeedRow {
  id: string;
  profile_type_id: string;
  seed_kind: string;
  value: string;
  refresh_interval_hours: number;
  last_crawled_at: string | null;
  success_count: number;
  entity_count: number;
  enabled: number;
}

export interface SweepResult {
  picked: number;
  enqueued: number;
  bootstrapped: number;
  errors: number;
}

const DEFAULT_LIMIT = 100;

export async function pickStaleSeeds(env: Env, limit = DEFAULT_LIMIT): Promise<SeedRow[]> {
  // SQLite datetime arithmetic via expr: a seed is stale when
  //   last_crawled_at IS NULL  OR  datetime(last_crawled_at, +N hours) <= now
  const r = await env.DB.prepare(
    `SELECT id, profile_type_id, seed_kind, value, refresh_interval_hours,
            last_crawled_at, success_count, entity_count, enabled
       FROM crawler_seeds
      WHERE enabled = 1
        AND (
              last_crawled_at IS NULL
           OR datetime(last_crawled_at, '+' || refresh_interval_hours || ' hours')
              <= datetime('now')
            )
      ORDER BY last_crawled_at IS NULL DESC, last_crawled_at ASC
      LIMIT ?`,
  ).bind(limit).all<SeedRow>();
  return r.results ?? [];
}

async function touchSeed(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE crawler_seeds
        SET last_crawled_at = CURRENT_TIMESTAMP,
            updated_at      = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).bind(id).run();
}

async function bumpCounters(env: Env, id: string, opts: { success?: number; entities?: number }): Promise<void> {
  await env.DB.prepare(
    `UPDATE crawler_seeds
        SET success_count = success_count + ?,
            entity_count  = entity_count + ?,
            updated_at    = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).bind(opts.success ?? 0, opts.entities ?? 0, id).run();
}

// Public helper for the discovery/extraction path: when a seed-originated
// crawl yields N entities, the extractor calls this to keep operator-
// visible `entity_count` honest. Looks up the seed by URL canonical so
// callers don't need to thread seed_id through the workflow chain.
export async function recordSeedEntitiesByUrl(env: Env, sourceUrl: string, n: number): Promise<void> {
  if (!n || !sourceUrl) return;
  // Build the set of acceptable seed value spellings:
  //   - the raw URL as the caller passed it,
  //   - its canonical form (no trailing slash, sorted/cleaned query),
  //   - both with and without trailing slash on the path,
  // so a seed stored as `https://a16z.com/team/` still matches a crawl
  // of canonical `https://a16z.com/team`.
  const candidates = new Set<string>();
  candidates.add(sourceUrl);
  const can = canonicalizeUrl(sourceUrl);
  if (can) {
    candidates.add(can.url);
    candidates.add(can.canonical);
    // Add slash/non-slash variants of the display form.
    const withSlash = can.url.endsWith("/") ? can.url : can.url + "/";
    const withoutSlash = can.url.endsWith("/") && can.url.length > can.url.indexOf("//") + 3 + can.host.length + 1
      ? can.url.slice(0, -1)
      : can.url;
    candidates.add(withSlash);
    candidates.add(withoutSlash);
  }
  const values = [...candidates];
  const placeholders = values.map(() => "?").join(",");
  try {
    await env.DB.prepare(
      `UPDATE crawler_seeds
          SET entity_count = entity_count + ?,
              updated_at   = CURRENT_TIMESTAMP
        WHERE seed_kind = 'url' AND value IN (${placeholders})`,
    ).bind(n, ...values).run();
  } catch (e) {
    console.warn("recordSeedEntitiesByUrl failed", (e as Error).message);
  }
}

async function enqueueUrl(env: Env, url: string): Promise<boolean> {
  try {
    if (env.WF_DISCOVER_FROM_SEED) {
      await env.WF_DISCOVER_FROM_SEED.create({ params: { url, depthMax: 2, maxPerHost: 200 } });
      return true;
    }
    const { runDiscoverFromSeed } = await import("../../discovery/runDiscovery");
    await runDiscoverFromSeed(env, { url, depthMax: 1, maxPerHost: 50 });
    return true;
  } catch (e) {
    console.warn("enqueueUrl failed", url, (e as Error).message);
    return false;
  }
}

// Run a single seed by its row. Shared by both the bulk sweep and the
// manual `POST /api/crawler-seeds/:id/run` endpoint so the contract is
// identical: touch last_crawled_at up-front, then process by kind.
async function runOneSeed(env: Env, seed: SeedRow, out: SweepResult): Promise<void> {
  await touchSeed(env, seed.id);
  if (seed.seed_kind === "url") {
    const ok = await enqueueUrl(env, seed.value);
    if (ok) { out.enqueued++; await bumpCounters(env, seed.id, { success: 1 }); }
    else { out.errors++; }
  } else if (seed.seed_kind === "search_query") {
    const candidates = await bootstrapEntity(env, { name: seed.value, profile_type_id: seed.profile_type_id, limit: 8 });
    out.bootstrapped += candidates.length;
    let success = 0;
    let entities = 0;
    for (const c of candidates) {
      const ok = await enqueueUrl(env, c.url);
      if (ok) success++;
      // High-confidence canonical sources (official site, LinkedIn,
      // Crunchbase, Wikipedia) count as one resolved entity each — they
      // are the canonical pages the downstream extractor will harvest.
      if (c.kind !== "other") entities++;
    }
    if (success > 0 || entities > 0) await bumpCounters(env, seed.id, { success, entities });
    out.enqueued += success;
  } else if (seed.seed_kind === "directory_pattern") {
    // Marker only — adapter is a follow-up. Touch keeps the sweep
    // moving so a thousand directory_pattern rows do not block real
    // url-kind seeds.
  } else {
    console.warn("unknown seed_kind", seed.seed_kind, seed.id);
    out.errors++;
  }
}

export async function runSeedSweep(env: Env, limit = DEFAULT_LIMIT): Promise<SweepResult> {
  const seeds = await pickStaleSeeds(env, limit);
  const out: SweepResult = { picked: seeds.length, enqueued: 0, bootstrapped: 0, errors: 0 };
  for (const seed of seeds) {
    try { await runOneSeed(env, seed, out); }
    catch (e) { out.errors++; console.warn("runSeedSweep seed failed", seed.id, (e as Error).message); }
  }
  return out;
}

// Manual single-seed run. Looks up the row by id and processes it
// directly so the operator's POST /api/crawler-seeds/:id/run is
// guaranteed to act on the requested seed (not whichever row happens to
// sort first when many are stale).
export async function runSeedById(env: Env, id: string): Promise<SweepResult & { found: boolean }> {
  const row = await env.DB.prepare(
    `SELECT id, profile_type_id, seed_kind, value, refresh_interval_hours,
            last_crawled_at, success_count, entity_count, enabled
       FROM crawler_seeds WHERE id = ?`,
  ).bind(id).first<SeedRow>();
  if (!row) return { picked: 0, enqueued: 0, bootstrapped: 0, errors: 0, found: false };
  if (row.enabled !== 1) return { picked: 0, enqueued: 0, bootstrapped: 0, errors: 0, found: true };
  const out: SweepResult = { picked: 1, enqueued: 0, bootstrapped: 0, errors: 0 };
  try { await runOneSeed(env, row, out); }
  catch (e) { out.errors++; console.warn("runSeedById failed", id, (e as Error).message); }
  return { ...out, found: true };
}
