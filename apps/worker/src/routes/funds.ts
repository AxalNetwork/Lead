// Task #3: Fund Intelligence Engine API routes.
//
//   GET /api/firms/:id/funds                  — every fund for one GP firm
//   GET /api/funds/:id                        — one fund's full record
//                                                + portfolio + dry powder
//                                                + vintage cohort
//   GET /api/funds/raising-now                — funds with status='raising'
//   GET /api/funds/dry-powder-leaderboard     — ranked by mid-band dry powder
//
// All routes mount under /api/* (accessGuard) in apps/worker/src/index.ts.
// Funds data is platform-global; there is no per-operator owner column.

import { Hono } from "hono";
import type { Env } from "../types";
import { computeDryPowder } from "../services/funds/dryPowder";
import { buildFundPortfolio } from "../services/funds/portfolio";
import { computeVintageCohort, percentileOfFund, performanceQuartileOfFund } from "../services/funds/vintage";
import { computeStrategyDrift } from "../services/funds/strategyDrift";
import type { FundRow } from "../services/funds/types";

type Vars = { email: string; is_admin: boolean };

export const fundsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();
export const firmsFundsRoute = new Hono<{ Bindings: Env; Variables: Vars }>();

const FUND_COLS = `id, firm_entity_id, fund_entity_id, fund_name, fund_number,
  vintage_year, target_size_usd, hard_cap_usd, first_close_date,
  final_close_date, announced_raised_usd, gp_commit_usd,
  mgmt_fee_pct, carry_pct, hurdle_pct, strategy, sectors_json,
  geos_json, fund_status, source_evidence_json, confidence,
  updated_at, created_at`;

function clampLimit(raw: string | undefined, def = 50, max = 200): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.trunc(n), max);
}

function safeJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function shape(row: FundRow) {
  return {
    id: row.id,
    firm_entity_id: row.firm_entity_id,
    fund_entity_id: row.fund_entity_id,
    fund_name: row.fund_name,
    fund_number: row.fund_number,
    vintage_year: row.vintage_year,
    target_size_usd: row.target_size_usd,
    hard_cap_usd: row.hard_cap_usd,
    first_close_date: row.first_close_date,
    final_close_date: row.final_close_date,
    announced_raised_usd: row.announced_raised_usd,
    gp_commit_usd: row.gp_commit_usd,
    mgmt_fee_pct: row.mgmt_fee_pct,
    carry_pct: row.carry_pct,
    hurdle_pct: row.hurdle_pct,
    strategy: row.strategy,
    sectors: safeJson<string[]>(row.sectors_json) ?? [],
    geos: safeJson<string[]>(row.geos_json) ?? [],
    fund_status: row.fund_status,
    source_evidence: safeJson<unknown[]>(row.source_evidence_json) ?? [],
    confidence: row.confidence,
    updated_at: row.updated_at,
  };
}

// ---------------- GET /api/firms/:id/funds ----------------
firmsFundsRoute.get("/:id/funds", async (c) => {
  const firmId = c.req.param("id");
  const rows = await c.env.DB.prepare(
    `SELECT ${FUND_COLS} FROM funds
      WHERE firm_entity_id = ?
      ORDER BY COALESCE(vintage_year, 0) DESC, COALESCE(fund_number, 0) DESC`,
  ).bind(firmId).all<FundRow>();
  const fundRows = rows.results ?? [];
  // Per-fund dry powder band — spec "Done looks like" requires the
  // firm-level fund list to surface mid/low/high so the UI can show
  // an aggregate without a second round-trip.
  const enriched = await Promise.all(fundRows.map(async (r) => ({
    ...shape(r),
    dry_powder: await computeDryPowder(c.env, r.id),
  })));
  return c.json({
    firm_entity_id: firmId,
    fund_count: fundRows.length,
    aggregate_dry_powder_mid_usd: enriched.reduce((s, f) => s + (f.dry_powder?.mid ?? 0), 0),
    funds: enriched,
  });
});

// ---------------- GET /api/funds/raising-now ----------------
fundsRoute.get("/raising-now", async (c) => {
  const strategy = c.req.query("strategy");
  const min_target = c.req.query("min_target_usd");
  const geo = c.req.query("geo");
  const sector = c.req.query("sector");
  const limit = clampLimit(c.req.query("limit"));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const where: string[] = ["fund_status = 'raising'"];
  const binds: unknown[] = [];
  if (strategy) { where.push("strategy = ?"); binds.push(strategy); }
  if (min_target) { where.push("target_size_usd >= ?"); binds.push(Number(min_target)); }
  if (geo)    { where.push("lower(COALESCE(geos_json, '')) LIKE ?");    binds.push(`%${geo.toLowerCase()}%`); }
  if (sector) { where.push("lower(COALESCE(sectors_json, '')) LIKE ?"); binds.push(`%${sector.toLowerCase()}%`); }
  const rows = await c.env.DB.prepare(
    `SELECT ${FUND_COLS} FROM funds
      WHERE ${where.join(" AND ")}
      ORDER BY (target_size_usd IS NULL), target_size_usd DESC, updated_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all<FundRow>();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM funds WHERE ${where.join(" AND ")}`,
  ).bind(...binds).first<{ n: number }>();
  return c.json({
    total: total?.n ?? 0,
    limit, offset,
    funds: (rows.results ?? []).map(shape),
  });
});

// ---------------- GET /api/funds/dry-powder-leaderboard ----------------
fundsRoute.get("/dry-powder-leaderboard", async (c) => {
  const strategy = c.req.query("strategy");
  const geo = c.req.query("geo");
  const sector = c.req.query("sector");
  const limit = clampLimit(c.req.query("limit"), 25, 100);
  const where: string[] = [
    "fund_status IN ('raising', 'active')",
    "announced_raised_usd IS NOT NULL", "announced_raised_usd > 0",
  ];
  const binds: unknown[] = [];
  if (strategy) { where.push("strategy = ?"); binds.push(strategy); }
  if (geo)    { where.push("lower(COALESCE(geos_json, '')) LIKE ?");    binds.push(`%${geo.toLowerCase()}%`); }
  if (sector) { where.push("lower(COALESCE(sectors_json, '')) LIKE ?"); binds.push(`%${sector.toLowerCase()}%`); }
  // Pull a wider candidate set, score in JS via computeDryPowder, then
  // slice. We cap candidates so a global ranking stays bounded.
  const rows = await c.env.DB.prepare(
    `SELECT ${FUND_COLS} FROM funds
      WHERE ${where.join(" AND ")}
      ORDER BY announced_raised_usd DESC
      LIMIT 200`,
  ).bind(...binds).all<FundRow>();
  const candidates = rows.results ?? [];
  const scored: Array<{ fund: ReturnType<typeof shape>; dry_powder_mid_usd: number; band: { low: number; mid: number; high: number; assumptions: string[] } | null }> = [];
  for (const r of candidates) {
    const band = await computeDryPowder(c.env, r.id);
    scored.push({
      fund: shape(r),
      dry_powder_mid_usd: band?.mid ?? 0,
      band: band ? { low: band.low, mid: band.mid, high: band.high, assumptions: band.assumptions } : null,
    });
  }
  scored.sort((a, b) => b.dry_powder_mid_usd - a.dry_powder_mid_usd);
  return c.json({
    total: scored.length,
    limit,
    leaderboard: scored.slice(0, limit),
  });
});

// ---------------- GET /api/funds/:id ----------------
// MUST be declared AFTER all static /funds/* routes — Hono matches in
// declaration order, and a leading param route would otherwise shadow
// /raising-now and /dry-powder-leaderboard.
fundsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT ${FUND_COLS} FROM funds WHERE id = ?`,
  ).bind(id).first<FundRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const [dryPowder, portfolio, percentile, cohort, perfQuartile, driftReports] = await Promise.all([
    computeDryPowder(c.env, id),
    buildFundPortfolio(c.env, id),
    percentileOfFund(c.env, row),
    row.vintage_year ? computeVintageCohort(c.env, row.vintage_year, row.strategy) : Promise.resolve(null),
    performanceQuartileOfFund(c.env, row),
    computeStrategyDrift(c.env, id),
  ]);
  // Latest drift report is what operators care about; full history is
  // available via the `fund.strategy_drift` fact log.
  const latestDrift = driftReports.length > 0 ? driftReports[driftReports.length - 1] : null;
  return c.json({
    fund: shape(row),
    dry_powder: dryPowder,
    portfolio: portfolio?.positions ?? [],
    portfolio_summary: portfolio?.summary ?? null,
    vintage_cohort: cohort,
    size_percentile_within_cohort: percentile,
    performance_quartile: perfQuartile,
    strategy_drift_latest: latestDrift,
    strategy_drift_history: driftReports,
  });
});
