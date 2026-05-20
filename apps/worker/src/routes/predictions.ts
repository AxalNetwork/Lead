// Task #9: Predictions dashboard aggregator.
//
// GET /api/predictions/summary — single round trip serving the three
// predictive surfaces the platform already produces nightly:
//   1. Intro routing  — latest intro_paths row per target_entity_id,
//                       ranked by predicted_conversion_pct DESC.
//                       Honest degradation: rows that ran in
//                       ranking_mode="hop_count_only" carry a null
//                       predicted_conversion_pct (per Task #4 contract)
//                       and are returned as-is so the UI can flag them.
//   2. Fund returns   — latest fund_return_models row per fund_id,
//                       ranked by tvpi DESC. confidence column comes
//                       straight from the model row (high|medium|low).
//   3. Influence      — top-N from entity_influence by pagerank_score.
//
// Read-only, no re-derivation. Sits behind the global accessGuard
// mounted on /api/* in src/index.ts — same gating posture as
// /api/power-nodes (no inline adminOnly), since the spec wants the
// dashboard endpoint to mirror the other read-only surfaces.

import { Hono } from "hono";
import type { Env } from "../types";

export const predictionsRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function clampLimit(raw: string | undefined, def: number, max: number): number {
  const n = Math.floor(Number(raw ?? def));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

interface IntroRow {
  entity_id: string;
  display_name: string | null;
  predicted_conversion_pct: number | null;
  ranking_mode: string;
  hops: number;
  weakest_edge_quality: number | null;
  model_version: string | null;
  created_at: string;
}

interface FundRow {
  fund_id: string;
  fund_name: string | null;
  dpi: number | null;
  tvpi: number | null;
  moic: number | null;
  net_irr_pct: number | null;
  confidence: string;
  resolved_coverage_pct: number | null;
  positions_total: number;
  as_of: string;
  created_at: string;
}

interface InfluenceRow {
  entity_id: string;
  display_name: string | null;
  primary_sector: string | null;
  pagerank_score: number;
  broker_score: number;
  total_degree: number;
  is_power_node: number;
  computed_at: string;
}

predictionsRoute.get("/summary", async (c) => {
  const limit = clampLimit(c.req.query("limit"), 25, 100);

  // Wrap each table read in try/catch so a fresh install without
  // Task #2/#3/#4 model tables degrades to an empty list rather
  // than 500-ing the whole page.
  let intros: IntroRow[] = [];
  let funds: FundRow[] = [];
  let influence: InfluenceRow[] = [];
  let introMax: string | null = null;
  let fundMax: string | null = null;
  let influenceMax: string | null = null;

  try {
    // Latest path per target, ranked by predicted_conversion_pct DESC.
    // Rows in hop_count_only mode have a null predicted score and sort
    // last (NULLS LAST is the SQLite default for DESC).
    const r = await c.env.DB.prepare(
      `SELECT p.target_entity_id AS entity_id,
              e.display_name AS display_name,
              p.predicted_conversion_pct,
              p.ranking_mode,
              p.hops,
              p.weakest_edge_quality,
              p.model_version,
              p.created_at
         FROM intro_paths p
         JOIN (
           SELECT target_entity_id, MAX(created_at) AS mx
             FROM intro_paths
            GROUP BY target_entity_id
         ) j ON j.target_entity_id = p.target_entity_id AND j.mx = p.created_at
         LEFT JOIN u_entities e ON e.id = p.target_entity_id
        ORDER BY (p.predicted_conversion_pct IS NULL), p.predicted_conversion_pct DESC, p.created_at DESC
        LIMIT ?`,
    ).bind(limit).all<IntroRow>();
    intros = r.results ?? [];
    const m = await c.env.DB.prepare(
      `SELECT MAX(created_at) AS mx FROM intro_paths`,
    ).first<{ mx: string | null }>();
    introMax = m?.mx ?? null;
  } catch { /* table missing — leave empty */ }

  try {
    // Latest model run per fund_id. NOTE: per migration 366 the
    // `fund_return_models` table is append-only and has NO
    // `is_current` column — the contract documented in replit.md is
    // "the latest row per fund is 'current' for read paths". So
    // MAX(created_at) joined back on the same fund_id IS the
    // is_current=1 equivalent here; we do not filter on a column
    // that does not exist.
    const r = await c.env.DB.prepare(
      `SELECT m.fund_id,
              f.name AS fund_name,
              m.dpi, m.tvpi, m.moic, m.net_irr_pct,
              m.confidence, m.resolved_coverage_pct, m.positions_total,
              m.as_of, m.created_at
         FROM fund_return_models m
         JOIN (
           SELECT fund_id, MAX(created_at) AS mx
             FROM fund_return_models
            GROUP BY fund_id
         ) j ON j.fund_id = m.fund_id AND j.mx = m.created_at
         LEFT JOIN funds f ON f.id = m.fund_id
        ORDER BY m.tvpi DESC NULLS LAST, m.created_at DESC
        LIMIT ?`,
    ).bind(limit).all<FundRow>();
    funds = r.results ?? [];
    const m = await c.env.DB.prepare(
      `SELECT MAX(created_at) AS mx FROM fund_return_models`,
    ).first<{ mx: string | null }>();
    fundMax = m?.mx ?? null;
  } catch { /* table missing — leave empty */ }

  try {
    const r = await c.env.DB.prepare(
      `SELECT i.entity_id, e.display_name, i.primary_sector,
              i.pagerank_score, i.broker_score, i.total_degree,
              i.is_power_node, i.computed_at
         FROM entity_influence i
         LEFT JOIN u_entities e ON e.id = i.entity_id
        ORDER BY i.pagerank_score DESC
        LIMIT ?`,
    ).bind(limit).all<InfluenceRow>();
    influence = r.results ?? [];
    const m = await c.env.DB.prepare(
      `SELECT MAX(computed_at) AS mx FROM entity_influence`,
    ).first<{ mx: string | null }>();
    influenceMax = m?.mx ?? null;
  } catch { /* table missing — leave empty */ }

  // Pick the freshest model-run timestamp across all three surfaces
  // as the "last refreshed" indicator on the page header.
  const candidates = [introMax, fundMax, influenceMax].filter(
    (x): x is string => typeof x === "string" && !!x,
  );
  const lastRefreshed = candidates.length
    ? candidates.sort().slice(-1)[0]
    : null;

  return c.json({
    intros: {
      items: intros.map((r) => {
        const degraded = r.ranking_mode === "hop_count_only" || r.predicted_conversion_pct == null;
        // Confidence band per row: "limited" when the model ran in
        // hop_count_only fallback (no calibrated number); otherwise
        // derived from predicted_conversion_pct. Bands match the
        // fund-returns vocabulary (high / medium / low) so the UI
        // can render one consistent pill component across tabs.
        let band: "high" | "medium" | "low" | "limited";
        if (degraded) {
          band = "limited";
        } else if ((r.predicted_conversion_pct ?? 0) >= 0.5) {
          band = "high";
        } else if ((r.predicted_conversion_pct ?? 0) >= 0.2) {
          band = "medium";
        } else {
          band = "low";
        }
        return {
          entity_id: r.entity_id,
          display_name: r.display_name,
          predicted_conversion_pct: r.predicted_conversion_pct,
          confidence_band: band,
          ranking_mode: r.ranking_mode,
          hops: r.hops,
          weakest_edge_quality: r.weakest_edge_quality,
          model_version: r.model_version,
          created_at: r.created_at,
          // Honest degradation flag — surfaces in the UI as "limited
          // signal" so operators never see a fake confidence number.
          degraded,
        };
      }),
      last_computed_at: introMax,
    },
    funds: {
      items: funds.map((r) => ({
        fund_id: r.fund_id,
        fund_name: r.fund_name,
        dpi: r.dpi,
        tvpi: r.tvpi,
        moic: r.moic,
        net_irr_pct: r.net_irr_pct,
        confidence: r.confidence,
        resolved_coverage_pct: r.resolved_coverage_pct,
        positions_total: r.positions_total,
        as_of: r.as_of,
        created_at: r.created_at,
        // Honest degradation: confidence "low" is the model's own
        // signal that the run shouldn't be trusted as a ranking
        // input — surface it to the UI rather than hide it.
        degraded: r.confidence === "low",
      })),
      last_computed_at: fundMax,
    },
    influence: {
      items: influence.map((r) => ({
        entity_id: r.entity_id,
        display_name: r.display_name,
        primary_sector: r.primary_sector,
        pagerank_score: r.pagerank_score,
        broker_score: r.broker_score,
        total_degree: r.total_degree,
        is_power_node: !!r.is_power_node,
        computed_at: r.computed_at,
      })),
      last_computed_at: influenceMax,
    },
    last_refreshed: lastRefreshed,
  });
});
