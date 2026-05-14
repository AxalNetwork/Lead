// Daily provider budget tracker. Reads/writes provider_usage rows keyed by
// (provider, day=YYYY-MM-DD). `tryReserve` checks the cap *before* a call,
// `record` updates actual cost after the call, and `block` increments the
// blocked-call counter so /api/scrapers/health can surface budget pressure.

const day = () => new Date().toISOString().slice(0, 10);

export async function checkBudget(
  db: D1Database,
  provider: string,
  capUsd: number,
): Promise<{ allowed: boolean; spent: number }> {
  const row = await db
    .prepare("SELECT cost_usd FROM provider_usage WHERE provider = ? AND day = ?")
    .bind(provider, day())
    .first<{ cost_usd: number }>();
  const spent = row?.cost_usd ?? 0;
  if (capUsd > 0 && spent >= capUsd) return { allowed: false, spent };
  if (capUsd === 0) return { allowed: false, spent };
  return { allowed: true, spent };
}

export async function recordCall(
  db: D1Database,
  provider: string,
  costUsd: number,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO provider_usage (id, provider, day, calls, cost_usd, blocked_calls, updated_at)
       VALUES (?, ?, ?, 1, ?, 0, ?)
       ON CONFLICT(provider, day) DO UPDATE SET
         calls = calls + 1,
         cost_usd = cost_usd + excluded.cost_usd,
         updated_at = excluded.updated_at`,
    )
    .bind(crypto.randomUUID(), provider, day(), costUsd, now)
    .run();
}

export async function recordBlock(
  db: D1Database,
  provider: string,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO provider_usage (id, provider, day, calls, cost_usd, blocked_calls, last_block_reason, updated_at)
       VALUES (?, ?, ?, 0, 0, 1, ?, ?)
       ON CONFLICT(provider, day) DO UPDATE SET
         blocked_calls = blocked_calls + 1,
         last_block_reason = excluded.last_block_reason,
         updated_at = excluded.updated_at`,
    )
    .bind(crypto.randomUUID(), provider, day(), reason, now)
    .run();
}

export async function todayUsage(db: D1Database): Promise<Array<{ provider: string; calls: number; cost_usd: number; blocked_calls: number; last_block_reason: string | null }>> {
  const r = await db
    .prepare("SELECT provider, calls, cost_usd, blocked_calls, last_block_reason FROM provider_usage WHERE day = ? ORDER BY cost_usd DESC")
    .bind(day())
    .all<{ provider: string; calls: number; cost_usd: number; blocked_calls: number; last_block_reason: string | null }>();
  return r.results ?? [];
}
