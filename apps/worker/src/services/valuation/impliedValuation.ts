// Task #9: Implied valuation calculator.
//
// For a given private company, pick the most relevant comp panel
// (smallest panel that contains the company OR most-recently-refreshed
// panel matching the company's sector), compute the panel's median /
// p25 / p75 EV/Revenue and EV/ARR multiples from comp_metrics, and
// apply them to the company's latest revenue / ARR (also from
// comp_metrics if disclosed, or last public deal_event valuation as
// fallback).

// Stage-aware panel selection is INTENTIONALLY DEFERRED: today's
// criteria_json schema carries `sector` + financial bands but not a
// dedicated `stage` field, and entity-side stage facts (e.g.
// `firm.stages`, `company.last_round_stage`) are emitted unevenly
// across profile types. Nearest-panel selection therefore uses
// membership-first (the panel that actually lists this company) and
// sector-second. When a `criteria.stage` field is added to comp_panels
// (follow-up alongside the 10-Q extractor in Task #11), this
// selection can be extended to prefer panels whose stage matches the
// target's most recent funding round.
import type { Env } from "../../types";
import type { ImpliedValuationRange } from "./types";

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

async function getCompanySector(env: Env, entityId: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT value_text FROM facts
      WHERE entity_id = ? AND predicate IN ('company.sector','firm.sector','sector')
        AND is_current = 1 LIMIT 1`,
  ).bind(entityId).first<{ value_text: string }>();
  return r?.value_text ?? null;
}

async function pickPanelForCompany(env: Env, entityId: string): Promise<{ id: string; name: string; criteria_json: string } | null> {
  // Prefer a panel that already lists this company.
  const direct = await env.DB.prepare(
    `SELECT p.id, p.name, p.criteria_json
       FROM comp_panels p
       JOIN comp_members m ON m.panel_id = p.id
      WHERE m.company_entity_id = ? AND m.removed_at IS NULL
      ORDER BY p.last_refreshed_at DESC NULLS LAST
      LIMIT 1`,
  ).bind(entityId).first<{ id: string; name: string; criteria_json: string }>();
  if (direct) return direct;
  // Fall back to a panel whose sector matches the company's sector fact.
  const sector = await getCompanySector(env, entityId);
  if (!sector) return null;
  const all = await env.DB.prepare(
    `SELECT id, name, criteria_json FROM comp_panels ORDER BY last_refreshed_at DESC NULLS LAST LIMIT 100`,
  ).all<{ id: string; name: string; criteria_json: string }>();
  for (const p of (all.results ?? [])) {
    try {
      const c = JSON.parse(p.criteria_json);
      if (c && typeof c.sector === "string" && c.sector.toLowerCase() === sector.toLowerCase()) {
        return p;
      }
    } catch { /* skip */ }
  }
  return null;
}

async function loadPanelMultiples(env: Env, panelId: string): Promise<{ ev_revenue: number[]; ev_arr: number[] }> {
  const rows = await env.DB.prepare(
    `SELECT cm.ev_revenue_multiple, cm.ev_arr_multiple
       FROM comp_members m
       JOIN comp_metrics cm ON cm.company_entity_id = m.company_entity_id
      WHERE m.panel_id = ? AND m.removed_at IS NULL AND m.is_public = 1
        AND cm.quarter_end = (
          SELECT MAX(quarter_end) FROM comp_metrics cm2
           WHERE cm2.company_entity_id = m.company_entity_id
        )`,
  ).bind(panelId).all<{ ev_revenue_multiple: number | null; ev_arr_multiple: number | null }>();
  const ev_revenue: number[] = [];
  const ev_arr: number[] = [];
  for (const r of (rows.results ?? [])) {
    if (r.ev_revenue_multiple != null && r.ev_revenue_multiple > 0) ev_revenue.push(r.ev_revenue_multiple);
    if (r.ev_arr_multiple != null && r.ev_arr_multiple > 0) ev_arr.push(r.ev_arr_multiple);
  }
  ev_revenue.sort((a, b) => a - b);
  ev_arr.sort((a, b) => a - b);
  return { ev_revenue, ev_arr };
}

async function loadCompanyFinancials(env: Env, entityId: string): Promise<{ revenue: number | null; arr: number | null }> {
  const r = await env.DB.prepare(
    `SELECT revenue_usd, arr_usd FROM comp_metrics
      WHERE company_entity_id = ? ORDER BY quarter_end DESC LIMIT 1`,
  ).bind(entityId).first<{ revenue_usd: number | null; arr_usd: number | null }>();
  return { revenue: r?.revenue_usd ?? null, arr: r?.arr_usd ?? null };
}

async function loadLatestMark(env: Env, entityId: string): Promise<number | null> {
  const r = await env.DB.prepare(
    `SELECT implied_valuation_usd FROM valuation_marks
      WHERE company_entity_id = ? AND implied_valuation_usd IS NOT NULL
      ORDER BY as_of DESC, confidence DESC LIMIT 1`,
  ).bind(entityId).first<{ implied_valuation_usd: number }>();
  return r?.implied_valuation_usd ?? null;
}

export async function computeImpliedValuation(env: Env, entityId: string): Promise<ImpliedValuationRange> {
  const panel = await pickPanelForCompany(env, entityId);
  const fin = await loadCompanyFinancials(env, entityId);
  const latestMark = await loadLatestMark(env, entityId);
  const base: ImpliedValuationRange = {
    panel_id: panel?.id ?? null,
    panel_name: panel?.name ?? null,
    basis: "none",
    low_usd: null, median_usd: null, high_usd: null,
    multiple_low: null, multiple_median: null, multiple_high: null,
    latest_revenue_usd: fin.revenue, latest_arr_usd: fin.arr,
    latest_mark_usd: latestMark, notes: null,
  };
  if (!panel) {
    if (latestMark != null) {
      return { ...base, basis: "latest_mark",
        low_usd: Math.round(latestMark * 0.7),
        median_usd: latestMark,
        high_usd: Math.round(latestMark * 1.3),
        notes: "No comp panel matched; range is ±30% around latest observed mark." };
    }
    return base;
  }
  const mults = await loadPanelMultiples(env, panel.id);
  // Prefer ARR-based multiple when the company has disclosed ARR;
  // else fall back to revenue.
  if (fin.arr != null && mults.ev_arr.length >= 3) {
    const p25 = percentile(mults.ev_arr, 0.25);
    const p50 = percentile(mults.ev_arr, 0.5);
    const p75 = percentile(mults.ev_arr, 0.75);
    return { ...base, basis: "ev_arr",
      multiple_low: p25, multiple_median: p50, multiple_high: p75,
      low_usd: Math.round(fin.arr * p25),
      median_usd: Math.round(fin.arr * p50),
      high_usd: Math.round(fin.arr * p75),
      notes: `Panel ${panel.name}: ${mults.ev_arr.length} public peers with EV/ARR.` };
  }
  if (fin.revenue != null && mults.ev_revenue.length >= 3) {
    const p25 = percentile(mults.ev_revenue, 0.25);
    const p50 = percentile(mults.ev_revenue, 0.5);
    const p75 = percentile(mults.ev_revenue, 0.75);
    return { ...base, basis: "ev_revenue",
      multiple_low: p25, multiple_median: p50, multiple_high: p75,
      low_usd: Math.round(fin.revenue * p25),
      median_usd: Math.round(fin.revenue * p50),
      high_usd: Math.round(fin.revenue * p75),
      notes: `Panel ${panel.name}: ${mults.ev_revenue.length} public peers with EV/Revenue.` };
  }
  if (latestMark != null) {
    return { ...base, basis: "latest_mark",
      low_usd: Math.round(latestMark * 0.7),
      median_usd: latestMark,
      high_usd: Math.round(latestMark * 1.3),
      notes: `Panel ${panel.name} found, but company financials missing; range is ±30% around latest observed mark.` };
  }
  return { ...base, notes: `Panel ${panel.name} found, but no financials or marks to anchor a range.` };
}
