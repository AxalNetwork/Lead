// Task #18: Term benchmarks builder.
//
// Buckets `preferred_series` by (stage, sector, year) and writes one
// `term_benchmarks` row per bucket. Powers /api/term-benchmarks and
// the per-term percentile pills on the preferred-stack panel.
//
// Bucketing rules:
//   - stage      ← preferred_series.stage  (set by the parser from the series header)
//   - sector     ← preferred_series.sector (copied from company facts at write time,
//                                           falls back to "unknown")
//   - year       ← substr(closing_date, 1, 4); rows with no closing_date are
//                                           excluded — they cannot be bucketed
//                                           by vintage and would skew percentiles.
//   - MIN_SAMPLE = 5: buckets with fewer than 5 series are written WITH the
//                     sample_size so the API can flag low-confidence buckets,
//                     but their `payload_json` is shorter (just counts, no
//                     distributions).

import type { Env } from "../../types";

export const MIN_BUCKET_SAMPLE = 5;

export interface TermBenchmarkRow {
  stage: string;
  sector: string;
  year: number;
  sample_size: number;
  pct_lp_1x: number | null;
  pct_lp_gt_1x: number | null;
  pct_participating: number | null;
  pct_participating_capped: number | null;
  pct_uncapped_participating: number | null;
  pct_full_ratchet: number | null;
  pct_broad_weighted: number | null;
  pct_narrow_weighted: number | null;
  median_board_size: number | null;
  median_lp_x: number | null;
}

interface SeriesRow {
  stage: string | null;
  sector: string | null;
  closing_date: string | null;
  liquidation_pref_x: number | null;
  participating: number | null;
  participating_cap_x: number | null;
  anti_dilution: string | null;
  board_total: number | null;
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(num: number, den: number): number | null {
  return den > 0 ? Number((num / den).toFixed(4)) : null;
}

/** Bucket an in-memory set of series rows. Exported for unit testing. */
export function bucketSeries(rows: SeriesRow[]): TermBenchmarkRow[] {
  const buckets = new Map<string, SeriesRow[]>();
  for (const r of rows) {
    if (!r.stage || !r.closing_date) continue;
    const year = Number(r.closing_date.slice(0, 4));
    if (!Number.isFinite(year) || year < 1995 || year > 2100) continue;
    const sector = r.sector || "unknown";
    const key = `${r.stage}|${sector}|${year}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }
  const out: TermBenchmarkRow[] = [];
  for (const [key, rs] of buckets) {
    const [stage, sector, yearStr] = key.split("|");
    const year = Number(yearStr);
    const n = rs.length;
    const lpRows = rs.filter((r) => r.liquidation_pref_x != null) as Array<SeriesRow & { liquidation_pref_x: number }>;
    const participRows = rs.filter((r) => r.participating != null);
    const partTrue = participRows.filter((r) => r.participating === 1);
    const cappedPart = partTrue.filter((r) => r.participating_cap_x != null);
    const adRows = rs.filter((r) => r.anti_dilution != null);
    const boardRows = rs.filter((r) => r.board_total != null) as Array<SeriesRow & { board_total: number }>;
    out.push({
      stage, sector, year, sample_size: n,
      pct_lp_1x: lpRows.length ? pct(lpRows.filter((r) => r.liquidation_pref_x === 1).length, lpRows.length) : null,
      pct_lp_gt_1x: lpRows.length ? pct(lpRows.filter((r) => r.liquidation_pref_x > 1).length, lpRows.length) : null,
      pct_participating: participRows.length ? pct(partTrue.length, participRows.length) : null,
      pct_participating_capped: partTrue.length ? pct(cappedPart.length, partTrue.length) : null,
      pct_uncapped_participating: partTrue.length ? pct(partTrue.length - cappedPart.length, partTrue.length) : null,
      pct_full_ratchet: adRows.length ? pct(adRows.filter((r) => r.anti_dilution === "full_ratchet").length, adRows.length) : null,
      pct_broad_weighted: adRows.length ? pct(adRows.filter((r) => r.anti_dilution === "broad_weighted").length, adRows.length) : null,
      pct_narrow_weighted: adRows.length ? pct(adRows.filter((r) => r.anti_dilution === "narrow_weighted").length, adRows.length) : null,
      median_board_size: median(boardRows.map((r) => r.board_total)),
      median_lp_x: median(lpRows.map((r) => r.liquidation_pref_x)),
    });
  }
  return out;
}

export async function rebuildTermBenchmarks(env: Env): Promise<{ buckets: number; rows: number }> {
  const r = await env.DB.prepare(
    `SELECT stage, sector, closing_date, liquidation_pref_x, participating,
            participating_cap_x, anti_dilution, board_total
       FROM preferred_series
      WHERE is_current = 1`,
  ).all<SeriesRow>();
  const rows = r.results ?? [];
  const bench = bucketSeries(rows);
  let written = 0;
  for (const b of bench) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO term_benchmarks
         (id, stage, sector, year, sample_size,
          pct_lp_1x, pct_lp_gt_1x, pct_participating,
          pct_participating_capped, pct_uncapped_participating,
          pct_full_ratchet, pct_broad_weighted, pct_narrow_weighted,
          median_board_size, median_lp_x, payload_json, rebuilt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(stage, sector, year) DO UPDATE SET
         sample_size = excluded.sample_size,
         pct_lp_1x = excluded.pct_lp_1x,
         pct_lp_gt_1x = excluded.pct_lp_gt_1x,
         pct_participating = excluded.pct_participating,
         pct_participating_capped = excluded.pct_participating_capped,
         pct_uncapped_participating = excluded.pct_uncapped_participating,
         pct_full_ratchet = excluded.pct_full_ratchet,
         pct_broad_weighted = excluded.pct_broad_weighted,
         pct_narrow_weighted = excluded.pct_narrow_weighted,
         median_board_size = excluded.median_board_size,
         median_lp_x = excluded.median_lp_x,
         payload_json = excluded.payload_json,
         rebuilt_at = CURRENT_TIMESTAMP`,
    ).bind(
      id, b.stage, b.sector, b.year, b.sample_size,
      b.pct_lp_1x, b.pct_lp_gt_1x, b.pct_participating,
      b.pct_participating_capped, b.pct_uncapped_participating,
      b.pct_full_ratchet, b.pct_broad_weighted, b.pct_narrow_weighted,
      b.median_board_size, b.median_lp_x,
      JSON.stringify({ min_sample_threshold: MIN_BUCKET_SAMPLE, low_sample: b.sample_size < MIN_BUCKET_SAMPLE }),
    ).run();
    written++;
  }
  return { buckets: bench.length, rows: written };
}

/** Look up the benchmark row for a (stage, sector, year) bucket, falling
 *  back from sector-specific → "unknown" sector when the specific bucket
 *  is below sample threshold. Returns null when nothing applicable. */
export async function findBenchmark(
  env: Env, stage: string, sector: string | null, year: number | null,
): Promise<TermBenchmarkRow | null> {
  if (!stage || !year) return null;
  const tryKeys: Array<[string, string, number]> = [
    [stage, sector || "unknown", year],
    [stage, "unknown", year],
  ];
  for (const [s, sec, y] of tryKeys) {
    const row = await env.DB.prepare(
      `SELECT * FROM term_benchmarks WHERE stage = ? AND sector = ? AND year = ?`,
    ).bind(s, sec, y).first<TermBenchmarkRow>();
    if (row && row.sample_size >= MIN_BUCKET_SAMPLE) return row;
  }
  return null;
}
