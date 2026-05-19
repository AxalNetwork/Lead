// Task #2: Fund-Return Modeling routes.
//
//   GET /api/funds/:id/modeled-returns                — latest + history
//   GET /api/funds/:id/modeled-returns/attribution    — top-5 contributors
//
// Mounted under /api/funds in index.ts (after fundsRoute). Both
// endpoints sit behind the global accessGuard.

import { Hono } from "hono";
import type { Env } from "../types";

type Vars = { email: string; is_admin: boolean };

export const fundReturnsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

interface ModelRow {
  id: string;
  fund_id: string;
  model_version: string;
  as_of: string;
  committed_usd: number | null;
  called_usd: number | null;
  invested_usd: number | null;
  fee_drag_usd: number | null;
  distributed_usd: number;
  residual_value_usd: number;
  dpi: number | null;
  tvpi: number | null;
  moic: number | null;
  net_irr_pct: number | null;
  positions_total: number;
  positions_resolved: number;
  resolved_coverage_pct: number | null;
  confidence: string;
  bias_correction_applied: number | null;
  delta_vs_actual_json: string | null;
  attribution_json: string;
  warnings_json: string | null;
  created_at: string;
}

function safeJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function shape(r: ModelRow) {
  return {
    id: r.id,
    fund_id: r.fund_id,
    model_version: r.model_version,
    as_of: r.as_of,
    inputs: {
      committed_usd: r.committed_usd,
      called_usd: r.called_usd,
      invested_usd: r.invested_usd,
      fee_drag_usd: r.fee_drag_usd,
    },
    cashflows: {
      distributed_usd: r.distributed_usd,
      residual_value_usd: r.residual_value_usd,
    },
    metrics: {
      dpi: r.dpi,
      tvpi: r.tvpi,
      moic: r.moic,
      net_irr_pct: r.net_irr_pct,
    },
    coverage: {
      positions_total: r.positions_total,
      positions_resolved: r.positions_resolved,
      resolved_coverage_pct: r.resolved_coverage_pct,
      confidence: r.confidence,
    },
    calibration: {
      bias_correction_applied: r.bias_correction_applied,
      delta_vs_actual: safeJson(r.delta_vs_actual_json),
    },
    attribution: safeJson<unknown[]>(r.attribution_json) ?? [],
    warnings: safeJson<string[]>(r.warnings_json) ?? [],
    created_at: r.created_at,
  };
}

fundReturnsRoute.get("/:id/modeled-returns", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(20, Math.max(1, Number(c.req.query("history") ?? 5)));
  const rows = await c.env.DB.prepare(
    `SELECT * FROM fund_return_models WHERE fund_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(id, limit).all<ModelRow>();
  const all = (rows.results ?? []).map(shape);
  if (all.length === 0) {
    return c.json({ fund_id: id, latest: null, history: [] });
  }
  return c.json({ fund_id: id, latest: all[0], history: all });
});

fundReturnsRoute.get("/:id/modeled-returns/attribution", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT attribution_json, as_of FROM fund_return_models
      WHERE fund_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(id).first<{ attribution_json: string; as_of: string }>();
  if (!row) return c.json({ fund_id: id, as_of: null, contributors: [] });
  return c.json({
    fund_id: id,
    as_of: row.as_of,
    contributors: safeJson<unknown[]>(row.attribution_json) ?? [],
  });
});
