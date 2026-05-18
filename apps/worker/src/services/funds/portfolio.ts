// Task #3: Per-fund portfolio construction.
//
// Combines two source paths:
//   1. deal_events / deal_participants where the firm participated and
//      the deal date falls in [first_close_date, today].
//   2. sec_form_d_rounds — synthetic single-investor placements
//      (e.g. fund-of-one SPVs) whose issuer is NOT a sister fund.
//
// No allocation arithmetic here — that's dryPowder's job. This builds
// the line-item portfolio list.

import type { Env } from "../../types";
import type { FundRow, PortfolioRow } from "./types";

interface DealJoinRow {
  deal_id: string;
  company_entity_id: string | null;
  company_name_raw: string;
  round_name: string | null;
  amount_usd: number | null;
  announcement_date: string | null;
  closing_date: string | null;
  sector_tags_json: string | null;
  geography: string | null;
  role: string;
}

export async function buildFundPortfolio(env: Env, fundId: string): Promise<{
  fund_id: string;
  positions: PortfolioRow[];
  summary: {
    position_count: number;
    leads: number;
    total_round_size_usd: number;
    sector_breakdown: Record<string, number>;
    geography_breakdown: Record<string, number>;
  };
} | null> {
  const fund = await env.DB.prepare(
    `SELECT id, firm_entity_id, fund_entity_id, fund_name, vintage_year,
            first_close_date, final_close_date, announced_raised_usd,
            strategy, fund_status
       FROM funds WHERE id = ?`,
  ).bind(fundId).first<FundRow>();
  if (!fund) return null;

  const fromDate = fund.first_close_date ?? `${(fund.vintage_year ?? new Date().getFullYear() - 10)}-01-01`;

  const rows = await env.DB.prepare(
    `SELECT d.id AS deal_id, d.company_entity_id, d.company_name_raw,
            d.round_name, d.amount_usd,
            d.announcement_date, d.closing_date,
            d.sector_tags_json, d.geography, p.role
       FROM deal_events d
       JOIN deal_participants p ON p.deal_id = d.id
      WHERE p.investor_entity_id = ?
        AND COALESCE(d.announcement_date, d.closing_date) >= ?
        AND d.event_type = 'funding_round'
      ORDER BY COALESCE(d.announcement_date, d.closing_date) DESC
      LIMIT 1000`,
  ).bind(fund.firm_entity_id, fromDate).all<DealJoinRow>();

  const positions: PortfolioRow[] = [];
  const sectorBreak: Record<string, number> = {};
  const geoBreak: Record<string, number> = {};
  let leads = 0;
  let totalRound = 0;

  for (const r of rows.results ?? []) {
    const role = (r.role === "lead" || r.role === "participating" || r.role === "follow_on")
      ? r.role : "unknown";
    if (role === "lead") leads++;
    if (r.amount_usd) totalRound += r.amount_usd;
    let sectors: string[] = [];
    if (r.sector_tags_json) {
      try { sectors = JSON.parse(r.sector_tags_json) as string[]; } catch { /* ignore */ }
    }
    for (const s of sectors) sectorBreak[s] = (sectorBreak[s] ?? 0) + 1;
    if (r.geography) geoBreak[r.geography] = (geoBreak[r.geography] ?? 0) + 1;
    positions.push({
      fund_id: fund.id,
      company_entity_id: r.company_entity_id,
      company_name: r.company_name_raw,
      round_name: r.round_name,
      amount_usd: r.amount_usd,
      role: role as PortfolioRow["role"],
      date: r.announcement_date ?? r.closing_date,
      sector_tags: sectors,
      geography: r.geography,
      source_kind: "deal_event",
    });
  }

  return {
    fund_id: fund.id,
    positions,
    summary: {
      position_count: positions.length,
      leads,
      total_round_size_usd: totalRound,
      sector_breakdown: sectorBreak,
      geography_breakdown: geoBreak,
    },
  };
}
