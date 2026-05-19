// Task #3: Per-fund portfolio construction.
//
// Combines two source paths within the active investment window
// [first_close_date, final_close_date + 5y]:
//   1. deal_events + deal_participants where the firm participated.
//   2. sec_form_d_rounds whose related_persons list the firm — these
//      catch private placements (typical buyout / growth deals) that
//      may not appear in tech-press deal_events.
//
// Returns line-item positions plus aggregates required by the spec:
// pace per quarter, check-size p10/p50/p90, lead-vs-participant ratio,
// sector + geography mix by COUNT and by DOLLARS.

import type { Env } from "../../types";
import type { FundRow, PortfolioRow } from "./types";

interface DealJoinRow {
  deal_id: string;
  company_entity_id: string | null;
  company_name_raw: string;
  round_name: string | null;
  amount_usd: number | null;
  position_usd: number | null;
  announcement_date: string | null;
  closing_date: string | null;
  sector_tags_json: string | null;
  geography: string | null;
  role: string;
}

interface FormDJoinRow {
  id: string;
  issuer_name: string;
  total_amount_sold: number | null;
  total_offering_amount: number | null;
  date_of_first_sale: string | null;
  industry_group: string | null;
  related_persons_json: string;
  entity_id: string | null;
}

export interface PortfolioSummary {
  position_count: number;
  leads: number;
  participants: number;
  lead_ratio: number;                       // leads / position_count
  total_round_size_usd: number;             // sum of round amount_usd (deal_events)
  total_check_usd: number;                  // sum of position_usd (or amount_usd fallback)
  check_size_p10_usd: number | null;
  check_size_p50_usd: number | null;
  check_size_p90_usd: number | null;
  pace_per_quarter: Array<{ quarter: string; count: number; dollars_usd: number }>;
  sector_breakdown_by_count: Record<string, number>;
  sector_breakdown_by_dollars: Record<string, number>;
  geography_breakdown_by_count: Record<string, number>;
  geography_breakdown_by_dollars: Record<string, number>;
  window: { from: string; to: string };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function quarterOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 7);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

function addYearsIso(iso: string, years: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

export async function buildFundPortfolio(env: Env, fundId: string): Promise<{
  fund_id: string;
  positions: PortfolioRow[];
  summary: PortfolioSummary;
} | null> {
  const fund = await env.DB.prepare(
    `SELECT id, firm_entity_id, fund_entity_id, fund_name, vintage_year,
            first_close_date, final_close_date, announced_raised_usd,
            strategy, fund_status
       FROM funds WHERE id = ?`,
  ).bind(fundId).first<FundRow>();
  if (!fund) return null;

  // Active investment window: [first_close, final_close + 5y]. When
  // final_close is unknown, treat as today + 1y (still investing).
  // When first_close is unknown, fall back to vintage_year-01-01.
  const fromDate = fund.first_close_date
    ?? `${(fund.vintage_year ?? new Date().getUTCFullYear() - 10)}-01-01`;
  const toDate = fund.final_close_date
    ? addYearsIso(fund.final_close_date, 5)
    : addYearsIso(new Date().toISOString().slice(0, 10), 1);

  // --- 1. deal_events path ---------------------------------------------
  const dealRows = await env.DB.prepare(
    `SELECT d.id AS deal_id, d.company_entity_id, d.company_name_raw,
            d.round_name, d.amount_usd, p.position_usd,
            d.announcement_date, d.closing_date,
            d.sector_tags_json, d.geography, p.role
       FROM deal_events d
       JOIN deal_participants p ON p.deal_id = d.id
      WHERE p.investor_entity_id = ?
        AND d.event_type = 'funding_round'
        AND COALESCE(d.announcement_date, d.closing_date) >= ?
        AND COALESCE(d.announcement_date, d.closing_date) <= ?
      ORDER BY COALESCE(d.announcement_date, d.closing_date) DESC
      LIMIT 1000`,
  ).bind(fund.firm_entity_id, fromDate, toDate).all<DealJoinRow>();

  // --- 2. Form D path (private placements where firm is a related person)
  // Match by firm_entity_id when entity_id is set; otherwise fall back to
  // firm display name in related_persons_json. Keep small N — Form D is
  // a corroborating channel here.
  const firmNameRow = await env.DB.prepare(
    `SELECT display_name FROM u_entities WHERE id = ?`,
  ).bind(fund.firm_entity_id).first<{ display_name: string | null }>();
  const firmName = (firmNameRow?.display_name ?? "").trim();

  const formDRows = firmName
    ? await env.DB.prepare(
        `SELECT id, issuer_name, total_amount_sold, total_offering_amount,
                date_of_first_sale, industry_group, related_persons_json, entity_id
           FROM sec_form_d_rounds
          WHERE date_of_first_sale >= ? AND date_of_first_sale <= ?
            AND (entity_id = ? OR lower(related_persons_json) LIKE ?)
          ORDER BY date_of_first_sale DESC
          LIMIT 500`,
      ).bind(fromDate, toDate, fund.firm_entity_id, `%${firmName.toLowerCase()}%`)
       .all<FormDJoinRow>()
    : { results: [] as FormDJoinRow[] };

  // Dedupe Form D rows already represented in deal_events by issuer name
  // + month bucket, so a deal that surfaces in both press + Form D
  // appears once.
  const dealMonthKeys = new Set<string>();
  for (const d of dealRows.results ?? []) {
    const dt = d.announcement_date ?? d.closing_date;
    if (!dt) continue;
    dealMonthKeys.add(`${d.company_name_raw.toLowerCase()}|${dt.slice(0, 7)}`);
  }

  const positions: PortfolioRow[] = [];
  const checks: number[] = [];
  const sectorByCount: Record<string, number> = {};
  const sectorByDollars: Record<string, number> = {};
  const geoByCount: Record<string, number> = {};
  const geoByDollars: Record<string, number> = {};
  const paceMap: Map<string, { count: number; dollars_usd: number }> = new Map();
  let leads = 0;
  let participants = 0;
  let totalRound = 0;
  let totalCheck = 0;

  function recordSectorsGeo(sectors: string[], geo: string | null, dollarsForBreakdown: number) {
    for (const s of sectors) {
      sectorByCount[s] = (sectorByCount[s] ?? 0) + 1;
      sectorByDollars[s] = (sectorByDollars[s] ?? 0) + dollarsForBreakdown;
    }
    if (geo) {
      geoByCount[geo] = (geoByCount[geo] ?? 0) + 1;
      geoByDollars[geo] = (geoByDollars[geo] ?? 0) + dollarsForBreakdown;
    }
  }

  function recordPace(date: string | null, dollars: number) {
    if (!date) return;
    const q = quarterOf(date);
    const e = paceMap.get(q) ?? { count: 0, dollars_usd: 0 };
    e.count += 1;
    e.dollars_usd += dollars;
    paceMap.set(q, e);
  }

  for (const r of dealRows.results ?? []) {
    const role = (r.role === "lead" || r.role === "participating" || r.role === "follow_on")
      ? r.role : "unknown";
    if (role === "lead") leads++;
    else if (role === "participating" || role === "follow_on") participants++;
    if (r.amount_usd) totalRound += r.amount_usd;
    const check = r.position_usd ?? r.amount_usd ?? 0;
    if (check > 0) { checks.push(check); totalCheck += check; }
    let sectors: string[] = [];
    if (r.sector_tags_json) {
      try { sectors = JSON.parse(r.sector_tags_json) as string[]; } catch { /* ignore */ }
    }
    recordSectorsGeo(sectors, r.geography, check);
    recordPace(r.announcement_date ?? r.closing_date, check);
    positions.push({
      fund_id: fund.id,
      company_entity_id: r.company_entity_id,
      company_name: r.company_name_raw,
      round_name: r.round_name,
      amount_usd: r.amount_usd,
      position_usd: r.position_usd,
      role: role as PortfolioRow["role"],
      date: r.announcement_date ?? r.closing_date,
      sector_tags: sectors,
      geography: r.geography,
      source_kind: "deal_event",
    });
  }

  for (const f of formDRows.results ?? []) {
    const dt = f.date_of_first_sale;
    if (!dt) continue;
    const k = `${f.issuer_name.toLowerCase()}|${dt.slice(0, 7)}`;
    if (dealMonthKeys.has(k)) continue;          // dedupe: already in deal_events
    const sectors = f.industry_group ? [f.industry_group] : [];
    const check = f.total_amount_sold ?? f.total_offering_amount ?? 0;
    if (check > 0) { checks.push(check); totalCheck += check; }
    recordSectorsGeo(sectors, null, check);
    recordPace(dt, check);
    participants++;                              // Form D doesn't disclose role
    positions.push({
      fund_id: fund.id,
      company_entity_id: f.entity_id,
      company_name: f.issuer_name,
      round_name: null,
      amount_usd: f.total_amount_sold ?? f.total_offering_amount,
      // Form D discloses the round total, not the fund's check — leave
      // position_usd null rather than guess. Task #2 fund-return modeling
      // warns on null check sizes instead of treating the round as the
      // fund's investment.
      position_usd: null,
      role: "participating",
      date: dt,
      sector_tags: sectors,
      geography: null,
      source_kind: "form_d",
    });
  }

  checks.sort((a, b) => a - b);
  const pace = [...paceMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([quarter, v]) => ({ quarter, count: v.count, dollars_usd: v.dollars_usd }));

  const positionCount = positions.length;
  return {
    fund_id: fund.id,
    positions,
    summary: {
      position_count: positionCount,
      leads,
      participants,
      lead_ratio: positionCount > 0 ? Number((leads / positionCount).toFixed(3)) : 0,
      total_round_size_usd: totalRound,
      total_check_usd: totalCheck,
      check_size_p10_usd: percentile(checks, 0.10),
      check_size_p50_usd: percentile(checks, 0.50),
      check_size_p90_usd: percentile(checks, 0.90),
      pace_per_quarter: pace,
      sector_breakdown_by_count: sectorByCount,
      sector_breakdown_by_dollars: sectorByDollars,
      geography_breakdown_by_count: geoByCount,
      geography_breakdown_by_dollars: geoByDollars,
      window: { from: fromDate, to: toDate },
    },
  };
}
