// Task #2: per-host circuit breaker. 5 fails in a 10-min window trips the
// breaker for 1 hour. Subsequent fetches short-circuit with `circuit_open`
// until the trip expires. Backing store is the `host_circuit_breaker`
// D1 table created in migration 214.
//
// Reads are O(1) (PK lookup). Writes are idempotent and self-rotating
// (window slides forward whenever it expires). Failures of the breaker
// itself are swallowed — a missing row simply means "never failed", and
// a write error just skips counting, so the breaker can never cause the
// fetch path to crash.

import type { Env } from "../types";

const WINDOW_MS = 10 * 60 * 1000;      // 10-min rolling failure window
const TRIP_THRESHOLD = 5;              // failures inside the window
const TRIP_MS = 60 * 60 * 1000;        // 1h trip duration

interface BreakerRow {
  host: string;
  fail_count: number;
  window_start: string;
  tripped_until: string | null;
}

export async function isCircuitOpen(env: Env, host: string): Promise<string | null> {
  if (!host) return null;
  try {
    const r = await env.DB.prepare(
      `SELECT host, fail_count, window_start, tripped_until FROM host_circuit_breaker WHERE host = ?`,
    ).bind(host).first<BreakerRow>();
    if (!r || !r.tripped_until) return null;
    const until = Date.parse(r.tripped_until);
    if (Number.isFinite(until) && until > Date.now()) {
      return `circuit_open:${host}:until=${r.tripped_until}`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function recordFetchOutcome(env: Env, host: string, ok: boolean): Promise<void> {
  if (!host) return;
  try {
    if (ok) {
      // Success resets the counter and clears any trip.
      await env.DB.prepare(
        `INSERT INTO host_circuit_breaker (host, fail_count, window_start, tripped_until)
              VALUES (?, 0, ?, NULL)
              ON CONFLICT(host) DO UPDATE SET fail_count = 0, window_start = excluded.window_start, tripped_until = NULL`,
      ).bind(host, new Date().toISOString()).run();
      return;
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const existing = await env.DB.prepare(
      `SELECT fail_count, window_start FROM host_circuit_breaker WHERE host = ?`,
    ).bind(host).first<{ fail_count: number; window_start: string }>();

    let failCount = 1;
    let windowStart = nowIso;
    if (existing) {
      const winStart = Date.parse(existing.window_start);
      if (Number.isFinite(winStart) && now - winStart <= WINDOW_MS) {
        failCount = (existing.fail_count ?? 0) + 1;
        windowStart = existing.window_start;
      }
    }

    const trip = failCount >= TRIP_THRESHOLD;
    const trippedUntil = trip ? new Date(now + TRIP_MS).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO host_circuit_breaker (host, fail_count, window_start, tripped_until)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(host) DO UPDATE SET
              fail_count = excluded.fail_count,
              window_start = excluded.window_start,
              tripped_until = COALESCE(excluded.tripped_until, host_circuit_breaker.tripped_until)`,
    ).bind(host, failCount, windowStart, trippedUntil).run();
  } catch {
    /* swallow — breaker must never crash the fetch */
  }
}
