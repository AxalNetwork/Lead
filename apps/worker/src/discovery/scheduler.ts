// Task #2: frontier priority + politeness helpers.
//
// `computePriority` is pure — given a YieldVerdict + depth + host stats
// it returns a single float used by `popFrontier` to order the queue.
//
// `assertHostPolite` is the per-host *rate* gate. It enforces a minimum
// spacing between fetches to the same host (KV lock, FRONTIER_TTL_SEC).
// It does NOT enforce a run-wide host ceiling — that is the
// orchestrator's responsibility via `hostFetchCountInRun` (see
// `runDiscoverFromSeed`).

import type { Env } from "../types";

const FRONTIER_TTL_SEC = 8;       // ≥ 5s per host minimum spacing
const HOST_PER_5S_KEY = (host: string) => `disc:host:${host}`;

export interface PriorityInput {
  yield_score: number;
  depth: number;
  host: string;
  host_fetch_count_in_run: number;
  max_per_host: number;
}

export function computePriority(p: PriorityInput): number {
  // Base = yield, depth-decayed, diversity-penalized when host is hot.
  const depthDecay = 1 / (1 + p.depth * 0.6);
  const saturation = p.max_per_host > 0 ? Math.max(0, 1 - p.host_fetch_count_in_run / p.max_per_host) : 1;
  const diversity = saturation > 0.3 ? 1 : saturation;
  const score = p.yield_score * depthDecay * (0.5 + 0.5 * diversity);
  return Math.round(score * 10000) / 10000;
}

/**
 * Per-host politeness gate. Returns true if a fetch is allowed right
 * now; sets a KV lock for FRONTIER_TTL_SEC otherwise. Uses SCRAPE_CACHE
 * KV which the worker already provisions.
 */
export async function assertHostPolite(env: Env, host: string): Promise<boolean> {
  if (!host) return false;
  if (!env.SCRAPE_CACHE) return true; // fail open in tests
  const key = HOST_PER_5S_KEY(host);
  const cur = await env.SCRAPE_CACHE.get(key);
  if (cur) return false;
  await env.SCRAPE_CACHE.put(key, "1", { expirationTtl: FRONTIER_TTL_SEC });
  return true;
}
