// Task #3: Vintage benchmarking.
//
// Cohort-level aggregates over the `funds` ledger keyed by
// (vintage_year, strategy). Surfaces median raised, count, and a thin
// "size percentile within cohort" helper used by the funds API.

import type { Env } from "../../types";
import type { FundRow, FundStrategy } from "./types";

export interface VintageCohort {
  vintage_year: number;
  strategy: FundStrategy | null;
  fund_count: number;
  median_raised_usd: number | null;
  mean_raised_usd: number | null;
  p25_raised_usd: number | null;
  p75_raised_usd: number | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export async function computeVintageCohort(
  env: Env, vintageYear: number, strategy: FundStrategy | null,
): Promise<VintageCohort> {
  const where: string[] = ["vintage_year = ?", "announced_raised_usd IS NOT NULL", "announced_raised_usd > 0"];
  const binds: unknown[] = [vintageYear];
  if (strategy) { where.push("strategy = ?"); binds.push(strategy); }
  const rows = await env.DB.prepare(
    `SELECT announced_raised_usd FROM funds WHERE ${where.join(" AND ")}`,
  ).bind(...binds).all<{ announced_raised_usd: number }>();
  const xs = (rows.results ?? []).map((r) => r.announced_raised_usd).sort((a, b) => a - b);
  if (xs.length === 0) {
    return {
      vintage_year: vintageYear, strategy,
      fund_count: 0,
      median_raised_usd: null, mean_raised_usd: null,
      p25_raised_usd: null, p75_raised_usd: null,
    };
  }
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  return {
    vintage_year: vintageYear, strategy,
    fund_count: xs.length,
    median_raised_usd: percentile(xs, 0.5),
    mean_raised_usd: mean,
    p25_raised_usd: percentile(xs, 0.25),
    p75_raised_usd: percentile(xs, 0.75),
  };
}

/** LP-disclosed performance cohort: quartile placement within
 *  (vintage_year, strategy) using net_irr_pct / tvpi / dpi from
 *  lp_fund_commitments. Returns the most-recent disclosed metric per
 *  fund (avoiding stale prior-period rows). */
export async function performanceQuartileOfFund(env: Env, fund: FundRow): Promise<{
  vintage_year: number | null;
  strategy: FundStrategy | null;
  metric: "net_irr_pct" | "tvpi" | "dpi";
  fund_value: number | null;
  cohort_size: number;
  quartile: 1 | 2 | 3 | 4 | null;
  cohort_p25: number | null;
  cohort_p50: number | null;
  cohort_p75: number | null;
} | null> {
  if (!fund.vintage_year || !fund.fund_entity_id) return null;
  // Pull the latest LP-disclosed metric row per fund_entity_id in the
  // same vintage (+ strategy when known). Prefer net_irr_pct, then
  // tvpi, then dpi — whichever has the most cohort coverage.
  const cohortRows = await env.DB.prepare(
    `SELECT lp.fund_entity_id,
            lp.net_irr_pct, lp.tvpi, lp.dpi
       FROM lp_fund_commitments lp
       JOIN funds fu ON fu.fund_entity_id = lp.fund_entity_id
      WHERE fu.vintage_year = ?
        AND (? IS NULL OR fu.strategy = ?)
        AND lp.as_of_date = (
          SELECT MAX(as_of_date) FROM lp_fund_commitments
           WHERE fund_entity_id = lp.fund_entity_id
        )`,
  ).bind(fund.vintage_year, fund.strategy, fund.strategy).all<{
    fund_entity_id: string;
    net_irr_pct: number | null;
    tvpi: number | null;
    dpi: number | null;
  }>();
  const cohort = cohortRows.results ?? [];
  // Pick the metric with the most non-null coverage in this cohort.
  const cov = (k: "net_irr_pct" | "tvpi" | "dpi") => cohort.filter((r) => r[k] != null).length;
  const order: Array<"net_irr_pct" | "tvpi" | "dpi"> = ["net_irr_pct", "tvpi", "dpi"];
  let metric: "net_irr_pct" | "tvpi" | "dpi" = "net_irr_pct";
  let bestCov = 0;
  for (const k of order) { const n = cov(k); if (n > bestCov) { metric = k; bestCov = n; } }
  if (bestCov < 2) {
    return {
      vintage_year: fund.vintage_year, strategy: fund.strategy,
      metric, fund_value: null, cohort_size: bestCov,
      quartile: null, cohort_p25: null, cohort_p50: null, cohort_p75: null,
    };
  }
  const xs = cohort.map((r) => r[metric]).filter((v): v is number => v != null).sort((a, b) => a - b);
  const self = cohort.find((r) => r.fund_entity_id === fund.fund_entity_id);
  const selfVal = self ? (self[metric] ?? null) : null;
  const p25 = percentile(xs, 0.25);
  const p50 = percentile(xs, 0.5);
  const p75 = percentile(xs, 0.75);
  let quartile: 1 | 2 | 3 | 4 | null = null;
  if (selfVal != null && p25 != null && p50 != null && p75 != null) {
    if (selfVal >= p75) quartile = 4;
    else if (selfVal >= p50) quartile = 3;
    else if (selfVal >= p25) quartile = 2;
    else quartile = 1;
  }
  return {
    vintage_year: fund.vintage_year, strategy: fund.strategy,
    metric, fund_value: selfVal, cohort_size: xs.length,
    quartile, cohort_p25: p25, cohort_p50: p50, cohort_p75: p75,
  };
}

export async function percentileOfFund(env: Env, fund: FundRow): Promise<number | null> {
  if (!fund.vintage_year || !fund.announced_raised_usd) return null;
  const cohort = await computeVintageCohort(env, fund.vintage_year, fund.strategy);
  if (cohort.fund_count === 0) return null;
  const rows = await env.DB.prepare(
    `SELECT announced_raised_usd FROM funds
      WHERE vintage_year = ? AND ${fund.strategy ? "strategy = ?" : "1=1"}
        AND announced_raised_usd IS NOT NULL AND announced_raised_usd > 0`,
  ).bind(...(fund.strategy ? [fund.vintage_year, fund.strategy] : [fund.vintage_year]))
   .all<{ announced_raised_usd: number }>();
  const xs = (rows.results ?? []).map((r) => r.announced_raised_usd);
  if (xs.length === 0) return null;
  const below = xs.filter((v) => v < (fund.announced_raised_usd ?? 0)).length;
  return below / xs.length;
}
