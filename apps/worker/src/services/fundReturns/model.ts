// Task #2: Fund-level aggregation + model runner.
//
// Pulls portfolio positions, classifies each company's liquidity event,
// applies the proceeds estimator, aggregates to fund-level DPI/TVPI/MOIC/
// net_irr_pct, applies the latest bias correction, persists a new
// `fund_return_models` row, and mirrors the headline metrics through
// `insertFact` per the Task #1 canonical write contract.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { buildFundPortfolio } from "../funds/portfolio";
import type { FundRow } from "../funds/types";
import { estimateProceeds, scoreConfidence, computeFeeDrag, estimateOwnership } from "./proceeds";
import type { CompanyInputs, ExitSignal } from "./proceeds";
import { lookupBiasCorrection } from "./calibration";
import { MGMT_FEE_PCT_PER_YEAR, MODEL_VERSION } from "./types";
import type { AttributionRow, EventKind, FundReturnModel } from "./types";

interface DealForCompany {
  event_type: string;
  amount_usd: number | null;
  valuation_usd: number | null;
  announcement_date: string | null;
  source_url: string | null;
}

interface ValMarkRow {
  implied_valuation_usd: number | null;
  as_of: string;
  source_kind: string;
  source_url: string | null;
}

const EVENT_KIND_FROM_DEAL: Record<string, EventKind> = {
  ipo: "ipo",
  acquisition: "acquisition",
  merger: "merger",
  bankruptcy: "bankruptcy",
};

async function fetchExitSignal(
  env: Env,
  company_entity_id: string | null,
): Promise<ExitSignal | null> {
  if (!company_entity_id) return null;
  // Latest deal_events row that represents a liquidity event for the
  // company. We trust event_type assigned by services/deals/persist.ts.
  const exitDeal = await env.DB.prepare(
    `SELECT event_type, amount_usd, valuation_usd, announcement_date, source_url
       FROM deal_events
      WHERE company_entity_id = ?
        AND event_type IN ('ipo','acquisition','merger','bankruptcy')
      ORDER BY COALESCE(announcement_date, closing_date) DESC LIMIT 1`,
  ).bind(company_entity_id).first<DealForCompany>();

  if (exitDeal) {
    const kind = EVENT_KIND_FROM_DEAL[exitDeal.event_type];
    if (kind === "bankruptcy") {
      return { event_kind: "bankruptcy", event_date: exitDeal.announcement_date, source_url: exitDeal.source_url };
    }
    if (kind === "ipo") {
      // We don't always have shares_sold / offer_price; we feed
      // last_mark_valuation_usd from deal valuation as the fallback.
      return {
        event_kind: "ipo",
        event_date: exitDeal.announcement_date,
        last_mark_valuation_usd: exitDeal.valuation_usd ?? null,
        source_url: exitDeal.source_url,
      };
    }
    if (kind === "acquisition" || kind === "merger") {
      return {
        event_kind: kind,
        event_date: exitDeal.announcement_date,
        ma_deal_size_usd: exitDeal.amount_usd ?? exitDeal.valuation_usd ?? null,
        source_url: exitDeal.source_url,
      };
    }
  }
  // Fallback to latest valuation mark for unexited residual value.
  let mark: ValMarkRow | null = null;
  try {
    mark = await env.DB.prepare(
      `SELECT implied_valuation_usd, as_of, source_kind, source_url
         FROM valuation_marks
        WHERE company_entity_id = ? AND implied_valuation_usd IS NOT NULL
        ORDER BY as_of DESC LIMIT 1`,
    ).bind(company_entity_id).first<ValMarkRow>();
  } catch { /* valuation_marks may not exist in legacy test DBs */ }
  if (mark) {
    return {
      event_kind: "unexited",
      event_date: mark.as_of,
      last_mark_valuation_usd: mark.implied_valuation_usd,
      source_url: mark.source_url,
    };
  }
  return null;
}

/** Run the model for one fund. Returns the persisted row.
 *  Idempotent on (fund_id, as_of, model_version) — calling twice on
 *  the same day overwrites the row instead of appending. */
export async function runFundReturnModel(env: Env, fund: FundRow): Promise<FundReturnModel> {
  const as_of = new Date().toISOString().slice(0, 10);
  const portfolio = await buildFundPortfolio(env, fund.id);
  const warnings: string[] = [];
  if (!portfolio || portfolio.positions.length === 0) {
    warnings.push("empty_portfolio");
  }

  const positions = portfolio?.positions ?? [];
  const invested = positions.reduce((s, p) => s + (p.amount_usd ?? 0), 0);
  const committed = fund.announced_raised_usd ?? null;
  const fee_drag = computeFeeDrag(committed, fund.first_close_date, as_of, MGMT_FEE_PCT_PER_YEAR);
  const called = invested + fee_drag;

  // Estimate proceeds per company.
  let distributed = 0;
  let residual = 0;
  let resolved = 0;
  const contributions: AttributionRow[] = [];
  for (const p of positions) {
    const exit = await fetchExitSignal(env, p.company_entity_id);
    const ownership = exit?.last_mark_valuation_usd
      ? estimateOwnership(p.amount_usd, exit.last_mark_valuation_usd)
      : null;
    const inputs: CompanyInputs = {
      company_entity_id: p.company_entity_id,
      company_name: p.company_name,
      position_usd: p.amount_usd,
      ownership_pct: ownership,
      exit,
    };
    const est = estimateProceeds(inputs);
    distributed += est.realized_usd;
    residual += est.residual_usd;
    const contribution = est.realized_usd + est.residual_usd;
    if (est.event_kind === "ipo" || est.event_kind === "acquisition" || est.event_kind === "merger" || est.event_kind === "bankruptcy") {
      resolved += 1;
    }
    contributions.push({
      company_entity_id: p.company_entity_id,
      company_name: p.company_name,
      contribution_usd: contribution,
      share_pct: 0,                                  // back-filled below
      event_kind: est.event_kind,
    });
  }

  // Apply per-(vintage, strategy) bias correction to TVPI (and hence MOIC).
  const bias = await lookupBiasCorrection(env, fund.vintage_year, fund.strategy);
  const distributedAdj = distributed * bias;
  const residualAdj = residual * bias;

  const dpi = called > 0 ? distributedAdj / called : null;
  const tvpi = called > 0 ? (distributedAdj + residualAdj) / called : null;
  const moic = invested > 0 ? (distributedAdj + residualAdj) / invested : null;

  // Simplified annualized return: from (called, distributed+residual)
  // over years since first close. Returns null when duration unknown.
  let net_irr_pct: number | null = null;
  if (called > 0 && fund.first_close_date && tvpi != null && tvpi > 0) {
    const t0 = new Date(fund.first_close_date);
    const t1 = new Date(as_of);
    const years = (t1.getTime() - t0.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (years > 0.5) {
      net_irr_pct = (Math.pow(tvpi, 1 / years) - 1) * 100;
    }
  }

  const positions_total = positions.length;
  const resolved_coverage_pct = positions_total > 0 ? resolved / positions_total : null;
  const confidence = scoreConfidence(positions_total, resolved);

  // Per-run modeled-vs-actual delta: join against the latest LP-disclosed
  // tvpi/dpi for this fund_entity_id, if any. Logged in delta_vs_actual_json
  // so operators can inspect the gap on this exact run (the calibration
  // loop further aggregates these into bucket-level bias corrections).
  let delta_vs_actual: Record<string, unknown> | null = null;
  if (fund.fund_entity_id) {
    try {
      const actual = await env.DB.prepare(
        `SELECT tvpi AS actual_tvpi, dpi AS actual_dpi, as_of_date, source_url
           FROM lp_fund_commitments
          WHERE fund_entity_id = ? AND (tvpi IS NOT NULL OR dpi IS NOT NULL)
          ORDER BY as_of_date DESC LIMIT 1`,
      ).bind(fund.fund_entity_id).first<{ actual_tvpi: number | null; actual_dpi: number | null; as_of_date: string; source_url: string | null }>();
      if (actual) {
        delta_vs_actual = {
          as_of: actual.as_of_date,
          source_url: actual.source_url,
          tvpi: actual.actual_tvpi != null && tvpi != null
            ? { actual: actual.actual_tvpi, modeled: Number(tvpi.toFixed(4)), delta: Number((tvpi - actual.actual_tvpi).toFixed(4)) }
            : null,
          dpi: actual.actual_dpi != null && dpi != null
            ? { actual: actual.actual_dpi, modeled: Number(dpi.toFixed(4)), delta: Number((dpi - actual.actual_dpi).toFixed(4)) }
            : null,
        };
      }
    } catch { /* lp_fund_commitments may be absent in legacy DBs */ }
  }

  // Top-5 by contribution. Share % computed against total contribution.
  contributions.sort((a, b) => b.contribution_usd - a.contribution_usd);
  const totalContribution = contributions.reduce((s, c) => s + Math.max(0, c.contribution_usd), 0);
  for (const c of contributions) {
    c.share_pct = totalContribution > 0 ? (c.contribution_usd / totalContribution) : 0;
  }
  const top5 = contributions.slice(0, 5);

  if (committed == null) warnings.push("committed_unknown");
  if (!fund.first_close_date) warnings.push("first_close_unknown");
  if (positions_total === 0) warnings.push("no_positions");

  const out: FundReturnModel = {
    fund_id: fund.id,
    as_of,
    model_version: MODEL_VERSION,
    committed_usd: committed,
    called_usd: called > 0 ? called : null,
    invested_usd: invested > 0 ? invested : null,
    fee_drag_usd: fee_drag > 0 ? fee_drag : null,
    distributed_usd: distributedAdj,
    residual_value_usd: residualAdj,
    dpi,
    tvpi,
    moic,
    net_irr_pct,
    positions_total,
    positions_resolved: resolved,
    resolved_coverage_pct,
    confidence,
    bias_correction_applied: bias,
    delta_vs_actual,
    attribution: top5,
    warnings,
  };

  // Persist.
  await env.DB.prepare(
    `INSERT INTO fund_return_models (
       id, fund_id, model_version, as_of,
       committed_usd, called_usd, invested_usd, fee_drag_usd,
       distributed_usd, residual_value_usd,
       dpi, tvpi, moic, net_irr_pct,
       positions_total, positions_resolved, resolved_coverage_pct,
       confidence, bias_correction_applied, delta_vs_actual_json,
       attribution_json, warnings_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fund_id, as_of, model_version) DO UPDATE SET
       committed_usd = excluded.committed_usd,
       called_usd = excluded.called_usd,
       invested_usd = excluded.invested_usd,
       fee_drag_usd = excluded.fee_drag_usd,
       distributed_usd = excluded.distributed_usd,
       residual_value_usd = excluded.residual_value_usd,
       dpi = excluded.dpi,
       tvpi = excluded.tvpi,
       moic = excluded.moic,
       net_irr_pct = excluded.net_irr_pct,
       positions_total = excluded.positions_total,
       positions_resolved = excluded.positions_resolved,
       resolved_coverage_pct = excluded.resolved_coverage_pct,
       confidence = excluded.confidence,
       bias_correction_applied = excluded.bias_correction_applied,
       delta_vs_actual_json = excluded.delta_vs_actual_json,
       attribution_json = excluded.attribution_json,
       warnings_json = excluded.warnings_json`,
  ).bind(
    crypto.randomUUID(), fund.id, MODEL_VERSION, as_of,
    committed, out.called_usd, out.invested_usd, out.fee_drag_usd,
    out.distributed_usd, out.residual_value_usd,
    dpi, tvpi, moic, net_irr_pct,
    positions_total, resolved, resolved_coverage_pct,
    confidence, bias, delta_vs_actual ? JSON.stringify(delta_vs_actual) : null,
    JSON.stringify(top5), JSON.stringify(warnings),
  ).run();

  // Mirror headline metrics on the fund entity via insertFact (canonical
  // write path). source_kind="inferred" — these are model outputs, not
  // observed facts.
  if (fund.fund_entity_id) {
    const factCtx = {
      entity_id: fund.fund_entity_id,
      source_kind: "inferred" as const,
      source: "fund_return_model",
      evidence_url: null,
      confidence: confidence === "high" ? 0.85 : confidence === "medium" ? 0.6 : 0.4,
    };
    if (dpi != null)        await insertFact(env, { ...factCtx, predicate: "fund.dpi", value_number: Number(dpi.toFixed(4)) });
    if (tvpi != null)       await insertFact(env, { ...factCtx, predicate: "fund.tvpi", value_number: Number(tvpi.toFixed(4)) });
    if (moic != null)       await insertFact(env, { ...factCtx, predicate: "fund.moic", value_number: Number(moic.toFixed(4)) });
    if (net_irr_pct != null) await insertFact(env, { ...factCtx, predicate: "fund.net_irr_pct", value_number: Number(net_irr_pct.toFixed(2)) });
    await insertFact(env, { ...factCtx, predicate: "fund.return_confidence", value_text: confidence });
  }
  return out;
}

/** Nightly sweep: run the model for every fund. Bounded so it fits
 *  the consolidated `15 3 * * *` slot. */
export async function runNightlyFundReturnSweep(env: Env, limit = 200): Promise<{ ran: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, firm_entity_id, fund_entity_id, fund_name, fund_number,
            vintage_year, target_size_usd, hard_cap_usd, first_close_date,
            final_close_date, announced_raised_usd, gp_commit_usd,
            mgmt_fee_pct, carry_pct, hurdle_pct, strategy, sectors_json,
            geos_json, fund_status, source_evidence_json, confidence,
            updated_at, created_at
       FROM funds
      WHERE fund_status IN ('active','harvesting','wound_down')
      ORDER BY updated_at DESC LIMIT ?`,
  ).bind(limit).all<FundRow>();
  let ran = 0; let failed = 0;
  for (const fund of (rows.results ?? [])) {
    try { await runFundReturnModel(env, fund); ran += 1; }
    catch (e) { failed += 1; console.warn("fund return model failed", fund.id, (e as Error).message); }
  }
  return { ran, failed };
}
