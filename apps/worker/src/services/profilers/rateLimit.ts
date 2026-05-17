// Task #5: 7-day-per-entity rate limit for profiler runs.
//
// KV key: profiler:lastrun:{entityId}
// Value:  { runId, startedAt }
// TTL:    7 days
//
// force_refresh=true bypasses the limit but requires operator role and is
// audit-logged by the route handler (not here — single-responsibility).

import type { Env } from "../../types";

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const TTL_SECONDS = 7 * 24 * 3600;

export interface LastRunRecord {
  runId: string;
  startedAt: string; // ISO
}

function kvKey(entityId: string): string { return `profiler:lastrun:${entityId}`; }

export async function getLastRun(env: Env, entityId: string): Promise<LastRunRecord | null> {
  // SESSIONS is the always-present KV namespace in this worker.
  try {
    const raw = await env.SESSIONS.get(kvKey(entityId));
    if (!raw) return null;
    return JSON.parse(raw) as LastRunRecord;
  } catch {
    return null;
  }
}

export async function setLastRun(env: Env, entityId: string, rec: LastRunRecord): Promise<void> {
  try {
    await env.SESSIONS.put(kvKey(entityId), JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
  } catch { /* best-effort */ }
}

// clearLastRun — called by the route + orchestrator when a run could not
// be durably started (entity not found, wrong kind, dispatch error).
// Without this, a transient failure would lock the entity out of the
// profiler for 7 days — the limiter would degrade from "actual run"
// based to "attempt" based.
export async function clearLastRun(env: Env, entityId: string): Promise<void> {
  try { await env.SESSIONS.delete(kvKey(entityId)); } catch { /* best-effort */ }
}

export interface RateLimitDecision {
  allowed: boolean;
  nextEligibleAt?: string;  // ISO
  lastRunId?: string;
  reason?: "in_window";
}

export async function checkRateLimit(
  env: Env, entityId: string, opts: { forceRefresh?: boolean } = {},
): Promise<RateLimitDecision> {
  if (opts.forceRefresh) return { allowed: true };
  const last = await getLastRun(env, entityId);
  if (!last) return { allowed: true };
  const lastMs = Date.parse(last.startedAt);
  if (!Number.isFinite(lastMs)) return { allowed: true };
  const nextMs = lastMs + SEVEN_DAYS_MS;
  if (Date.now() >= nextMs) return { allowed: true };
  return {
    allowed: false,
    nextEligibleAt: new Date(nextMs).toISOString(),
    lastRunId: last.runId,
    reason: "in_window",
  };
}
