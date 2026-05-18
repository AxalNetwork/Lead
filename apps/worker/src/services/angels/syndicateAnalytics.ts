// Task #4: Per-syndicate analytics.
//
// For each handle observed in `angel_investments.via_syndicate_handle`
// or `angels.syndicate_handle`, recompute:
//   - deals_count, last_deal_at, avg_raise_usd, median_check_usd
//   - velocity_per_quarter (trailing 4 quarters)
//   - backer_count from syndicate_backers
// `lead_angel_entity_id` is preferred when stamped on the angels row;
// otherwise we infer it from the most frequent `person_entity_id` that
// carries the same syndicate_handle as `lead` on its investments.

import type { Env } from "../../types";

export interface SyndicateAnalyticsResult {
  handle: string;
  deals_count: number;
  last_deal_at: string | null;
  avg_raise_usd: number | null;
  median_check_usd: number | null;
  velocity_per_quarter: number;
  backer_count: number;
  lead_angel_entity_id: string | null;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quarterCutoffIso(quartersBack: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - quartersBack * 3);
  return d.toISOString().slice(0, 10);
}

interface InvRow {
  amount_usd: number | null;
  announced_at: string | null;
  role: string;
  person_entity_id: string;
  dedupe_key: string;
  deal_event_id: string | null;
}

export async function computeSyndicateAnalytics(
  env: Env, handle: string,
): Promise<SyndicateAnalyticsResult> {
  const res = await env.DB.prepare(
    `SELECT amount_usd, announced_at, role, person_entity_id, dedupe_key, deal_event_id
       FROM angel_investments
      WHERE via_syndicate_handle = ?
      ORDER BY announced_at DESC
      LIMIT 2000`,
  ).bind(handle).all<InvRow>();
  const rows = res.results ?? [];
  // deals_count / velocity must be distinct on the underlying deal — a
  // syndicate of N backers naming the same SPV would otherwise inflate
  // both metrics N-fold. dedupe_key is the canonical deal identity
  // (shared with deal_events.dedupe_key); deal_event_id is only set
  // when corroborated. Fall back to dedupe_key.
  const dealKey = (r: InvRow): string => r.deal_event_id ?? r.dedupe_key;
  const distinctDeals = new Map<string, InvRow>();
  for (const r of rows) {
    const k = dealKey(r);
    const existing = distinctDeals.get(k);
    // Prefer the row with the highest amount + most recent date as the
    // canonical "deal" record for median/avg purposes.
    if (!existing
        || (r.amount_usd ?? 0) > (existing.amount_usd ?? 0)
        || ((r.amount_usd ?? 0) === (existing.amount_usd ?? 0) && (r.announced_at ?? "") > (existing.announced_at ?? ""))) {
      distinctDeals.set(k, r);
    }
  }
  const uniqueRows = [...distinctDeals.values()];
  const checks = uniqueRows.map((r) => r.amount_usd).filter((n): n is number => typeof n === "number" && n > 0);
  const last = uniqueRows.reduce<string | null>((acc, r) => {
    if (r.announced_at && (!acc || r.announced_at > acc)) return r.announced_at;
    return acc;
  }, null);

  const cutoff = quarterCutoffIso(4);
  const trailing = uniqueRows.filter((r) => r.announced_at && r.announced_at >= cutoff);
  const velocity = trailing.length / 4;

  // Lead inference: most-frequent person who appears as 'lead' on this syndicate.
  const leadCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.role === "lead") leadCounts.set(r.person_entity_id, (leadCounts.get(r.person_entity_id) ?? 0) + 1);
  }
  let lead: string | null = null;
  let leadMax = 0;
  for (const [pid, n] of leadCounts) if (n > leadMax) { lead = pid; leadMax = n; }
  if (!lead) {
    // Fallback: existing angels.syndicate_handle = ?
    const row = await env.DB.prepare(
      `SELECT person_entity_id FROM angels WHERE syndicate_handle = ? ORDER BY confidence DESC LIMIT 1`,
    ).bind(handle).first<{ person_entity_id: string }>();
    lead = row?.person_entity_id ?? null;
  }

  const backersRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM syndicate_backers WHERE syndicate_handle = ?`,
  ).bind(handle).first<{ n: number }>();

  const avg = checks.length > 0 ? checks.reduce((s, n) => s + n, 0) / checks.length : null;

  return {
    handle,
    deals_count: uniqueRows.length,
    last_deal_at: last,
    avg_raise_usd: avg,
    median_check_usd: median(checks),
    velocity_per_quarter: velocity,
    backer_count: backersRow?.n ?? 0,
    lead_angel_entity_id: lead,
  };
}

/** Recompute analytics for every known syndicate handle and persist
 *  back to the `syndicates` table. Returns the count refreshed. */
export async function refreshAllSyndicateAnalytics(env: Env): Promise<number> {
  const handles = new Set<string>();
  const a = await env.DB.prepare(
    `SELECT DISTINCT via_syndicate_handle AS h FROM angel_investments
      WHERE via_syndicate_handle IS NOT NULL`,
  ).all<{ h: string }>();
  for (const r of a.results ?? []) if (r.h) handles.add(r.h);
  const b = await env.DB.prepare(
    `SELECT DISTINCT syndicate_handle AS h FROM angels WHERE syndicate_handle IS NOT NULL`,
  ).all<{ h: string }>();
  for (const r of b.results ?? []) if (r.h) handles.add(r.h);
  const c = await env.DB.prepare(`SELECT handle AS h FROM syndicates`).all<{ h: string }>();
  for (const r of c.results ?? []) if (r.h) handles.add(r.h);

  let n = 0;
  for (const handle of handles) {
    const a = await computeSyndicateAnalytics(env, handle);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO syndicates (
         handle, display_name, lead_angel_entity_id,
         focus_sectors_json, focus_stages_json, geos_json,
         backer_count, deals_count, last_deal_at,
         avg_raise_usd, median_check_usd, velocity_per_quarter,
         source_evidence_json, updated_at, created_at
       ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         lead_angel_entity_id = COALESCE(excluded.lead_angel_entity_id, syndicates.lead_angel_entity_id),
         backer_count         = excluded.backer_count,
         deals_count          = excluded.deals_count,
         last_deal_at         = excluded.last_deal_at,
         avg_raise_usd        = excluded.avg_raise_usd,
         median_check_usd     = excluded.median_check_usd,
         velocity_per_quarter = excluded.velocity_per_quarter,
         updated_at           = excluded.updated_at`,
    ).bind(
      handle, handle, a.lead_angel_entity_id,
      a.backer_count, a.deals_count, a.last_deal_at,
      a.avg_raise_usd, a.median_check_usd, a.velocity_per_quarter,
      new Date().toISOString(), new Date().toISOString(),
    ).run();
    void id;
    n++;
  }
  return n;
}

/** Pairwise backer overlap across syndicates — count of shared backer_entity_id. */
export async function syndicateOverlap(
  env: Env, handleA: string, handleB: string,
): Promise<{ syndicate_a: string; syndicate_b: string; shared_backer_count: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM syndicate_backers a
       JOIN syndicate_backers b ON a.backer_entity_id = b.backer_entity_id
      WHERE a.syndicate_handle = ? AND b.syndicate_handle = ?`,
  ).bind(handleA, handleB).first<{ n: number }>();
  return { syndicate_a: handleA, syndicate_b: handleB, shared_backer_count: row?.n ?? 0 };
}
