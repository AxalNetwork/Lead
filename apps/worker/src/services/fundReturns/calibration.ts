// Task #2: Calibration loop.
//
// When LP disclosures (Task #95) publish actual fund-level returns,
// store the modeled-vs-actual delta and compute a per-(vintage, strategy)
// bias correction. The correction is a multiplier baked into the
// modeled TVPI on subsequent runs.
//
// Task #2 dependency note: this is a no-op until LP disclosures with
// fund-level tvpi/dpi actuals exist in `lp_fund_commitments`. The
// reader path (applyBiasCorrection) returns 1.0 when no calibration
// row exists for the bucket — never silently invents one.

import type { Env } from "../../types";

export interface CalibrationRow {
  vintage_year: number;
  strategy: string | null;
  sample_size: number;
  median_delta_tvpi: number | null;
  median_delta_dpi: number | null;
  bias_correction: number;
  computed_at: string;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface DeltaRow { vintage_year: number; strategy: string | null; modeled_tvpi: number | null; actual_tvpi: number | null; modeled_dpi: number | null; actual_dpi: number | null }

/** Recompute calibration buckets from current fund_return_models +
 *  lp_fund_commitments. Idempotent. Returns the number of buckets
 *  updated. Safe to run nightly — buckets with sample_size < 3 are
 *  retained but flagged via low sample. */
export async function rebuildCalibration(env: Env): Promise<{ buckets: number; samples: number }> {
  // Pull the latest model row per fund and join to any LP-disclosed
  // actual TVPI/DPI on the same fund's most recent as_of_date.
  const rows = await env.DB.prepare(`
    WITH latest_model AS (
      SELECT m.*
        FROM fund_return_models m
        JOIN (SELECT fund_id, MAX(created_at) AS mx FROM fund_return_models GROUP BY fund_id) j
          ON j.fund_id = m.fund_id AND j.mx = m.created_at
    ),
    latest_actual AS (
      SELECT lp.fund_entity_id, lp.tvpi AS actual_tvpi, lp.dpi AS actual_dpi
        FROM lp_fund_commitments lp
        JOIN (SELECT fund_entity_id, MAX(as_of_date) AS mx
                FROM lp_fund_commitments
               WHERE tvpi IS NOT NULL OR dpi IS NOT NULL
               GROUP BY fund_entity_id) j
          ON j.fund_entity_id = lp.fund_entity_id AND j.mx = lp.as_of_date
    )
    SELECT f.vintage_year, f.strategy,
           m.tvpi AS modeled_tvpi, la.actual_tvpi,
           m.dpi  AS modeled_dpi,  la.actual_dpi
      FROM latest_model m
      JOIN funds f ON f.id = m.fund_id
      LEFT JOIN latest_actual la ON la.fund_entity_id = f.fund_entity_id
     WHERE f.vintage_year IS NOT NULL
       AND (la.actual_tvpi IS NOT NULL OR la.actual_dpi IS NOT NULL)
  `).all<DeltaRow>();

  type Bucket = { tvpi_deltas: number[]; dpi_deltas: number[] };
  const buckets = new Map<string, Bucket>();
  for (const r of (rows.results ?? [])) {
    const key = `${r.vintage_year}|${r.strategy ?? ""}`;
    const b = buckets.get(key) ?? { tvpi_deltas: [], dpi_deltas: [] };
    if (r.modeled_tvpi != null && r.actual_tvpi != null) {
      b.tvpi_deltas.push(r.modeled_tvpi - r.actual_tvpi);
    }
    if (r.modeled_dpi != null && r.actual_dpi != null) {
      b.dpi_deltas.push(r.modeled_dpi - r.actual_dpi);
    }
    buckets.set(key, b);
  }
  let samples = 0;
  for (const [key, b] of buckets) {
    const [vintageStr, strategy] = key.split("|");
    const vintage_year = Number(vintageStr);
    const mTvpi = median(b.tvpi_deltas);
    const mDpi = median(b.dpi_deltas);
    // Bias correction: if modeled is consistently above actual by Δ,
    // multiply next run's TVPI by (actual_median / modeled_median).
    // Bounded to [0.5, 1.5] to avoid wild swings on tiny samples.
    let bias = 1.0;
    if (mTvpi != null && b.tvpi_deltas.length >= 3) {
      // delta = modeled - actual ; correction multiplies modeled so
      // that modeled ≈ actual: factor = 1 - (delta / typical_modeled).
      // Approximate typical_modeled as 1.5 (TVPI midpoint).
      bias = Math.max(0.5, Math.min(1.5, 1 - mTvpi / 1.5));
    }
    samples += b.tvpi_deltas.length + b.dpi_deltas.length;
    // strategy_key '' (empty string) is the "strategy-agnostic" sentinel
    // — SQLite's UNIQUE treats NULLs as distinct, so we cannot use NULL
    // here or ON CONFLICT silently fails to upsert.
    await env.DB.prepare(`
      INSERT INTO fund_return_calibration
        (id, vintage_year, strategy_key, sample_size, median_delta_tvpi, median_delta_dpi, bias_correction, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(vintage_year, strategy_key) DO UPDATE SET
        sample_size = excluded.sample_size,
        median_delta_tvpi = excluded.median_delta_tvpi,
        median_delta_dpi = excluded.median_delta_dpi,
        bias_correction = excluded.bias_correction,
        computed_at = CURRENT_TIMESTAMP
    `).bind(
      crypto.randomUUID(), vintage_year, strategy || "",
      b.tvpi_deltas.length, mTvpi, mDpi, bias,
    ).run();
  }
  return { buckets: buckets.size, samples };
}

/** Pure bias application: multiplies distributed and residual cashflows
 *  by the bucket's bias correction and recomputes DPI / TVPI / MOIC.
 *  Extracted as a pure helper so the (vintage, strategy) → bias →
 *  metric transform is unit-testable without a DB. The runner calls
 *  this after `lookupBiasCorrection` in `runFundReturnModel`. */
export interface BiasInputs {
  distributed_usd: number;
  residual_usd: number;
  called_usd: number;
  invested_usd: number;
  bias: number;
}
export interface BiasOutputs {
  distributed_adj_usd: number;
  residual_adj_usd: number;
  dpi: number | null;
  tvpi: number | null;
  moic: number | null;
}
export function applyBiasCorrection(i: BiasInputs): BiasOutputs {
  const distributedAdj = i.distributed_usd * i.bias;
  const residualAdj = i.residual_usd * i.bias;
  return {
    distributed_adj_usd: distributedAdj,
    residual_adj_usd: residualAdj,
    dpi: i.called_usd > 0 ? distributedAdj / i.called_usd : null,
    tvpi: i.called_usd > 0 ? (distributedAdj + residualAdj) / i.called_usd : null,
    moic: i.invested_usd > 0 ? (distributedAdj + residualAdj) / i.invested_usd : null,
  };
}

export async function lookupBiasCorrection(
  env: Env, vintage_year: number | null, strategy: string | null,
): Promise<number> {
  if (vintage_year == null) return 1.0;
  // Prefer strategy-specific; fall back to strategy-agnostic ('' key).
  // ORDER BY computed_at DESC guarantees deterministic selection even
  // if duplicate rows ever appeared from a legacy/migrated run.
  const exact = await env.DB.prepare(
    `SELECT bias_correction FROM fund_return_calibration
      WHERE vintage_year = ? AND strategy_key = ? AND sample_size >= 3
      ORDER BY computed_at DESC LIMIT 1`,
  ).bind(vintage_year, strategy ?? "").first<{ bias_correction: number }>();
  if (exact) return exact.bias_correction;
  const any = await env.DB.prepare(
    `SELECT bias_correction FROM fund_return_calibration
      WHERE vintage_year = ? AND strategy_key = '' AND sample_size >= 3
      ORDER BY computed_at DESC LIMIT 1`,
  ).bind(vintage_year).first<{ bias_correction: number }>();
  return any?.bias_correction ?? 1.0;
}
