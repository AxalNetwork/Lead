// Task #3: Dry-powder estimator.
//
// computeDryPowder(fund_id) returns a {low, mid, high} band — never a
// point estimate. Each band carries the explicit list of assumptions
// used (per-strategy lead-share, reserve %, fee %). The API layer
// surfaces the assumptions[] so the UI never renders a bare number.
//
// total_raised = max(announced_raised_usd, sum_form_d_amount_sold, sum_lp_committed)
// deployed     = Σ deal_events.amount_usd × estimated_lead_share_pct
//                where this firm participated, within
//                [first_close_date, today]
// dry_powder   = total_raised − deployed − estimated_fees − estimated_reserves

import type { Env } from "../../types";
import type { DryPowderBand, FundRow, FundStrategy } from "./types";

interface StrategyDefaults {
  lead_share_pct: number;        // when the firm leads
  participant_share_pct: number; // when the firm only participates
  fee_pct_annual: number;        // mgmt fee on committed
  reserve_pct: number;           // % of fund held for follow-ons
}

const DEFAULTS: Record<string, StrategyDefaults> = {
  seed:          { lead_share_pct: 0.60, participant_share_pct: 0.15, fee_pct_annual: 0.025, reserve_pct: 0.50 },
  early:         { lead_share_pct: 0.50, participant_share_pct: 0.12, fee_pct_annual: 0.020, reserve_pct: 0.50 },
  growth:        { lead_share_pct: 0.40, participant_share_pct: 0.10, fee_pct_annual: 0.020, reserve_pct: 0.30 },
  late:          { lead_share_pct: 0.30, participant_share_pct: 0.08, fee_pct_annual: 0.018, reserve_pct: 0.20 },
  buyout:        { lead_share_pct: 0.70, participant_share_pct: 0.20, fee_pct_annual: 0.020, reserve_pct: 0.15 },
  growth_equity: { lead_share_pct: 0.50, participant_share_pct: 0.15, fee_pct_annual: 0.020, reserve_pct: 0.20 },
  secondary:     { lead_share_pct: 0.80, participant_share_pct: 0.30, fee_pct_annual: 0.015, reserve_pct: 0.10 },
  fund_of_funds: { lead_share_pct: 0.90, participant_share_pct: 0.40, fee_pct_annual: 0.010, reserve_pct: 0.05 },
  credit:        { lead_share_pct: 0.60, participant_share_pct: 0.15, fee_pct_annual: 0.015, reserve_pct: 0.10 },
  unknown:       { lead_share_pct: 0.50, participant_share_pct: 0.12, fee_pct_annual: 0.020, reserve_pct: 0.30 },
};

function defaultsFor(strategy: FundStrategy | null | undefined): StrategyDefaults {
  return DEFAULTS[(strategy ?? "unknown") as string] ?? DEFAULTS.unknown;
}

interface ParticipationRow {
  deal_id: string;
  amount_usd: number | null;
  role: string;
  date: string | null;
}

export async function computeDryPowder(env: Env, fundId: string): Promise<DryPowderBand | null> {
  const fund = await env.DB.prepare(
    `SELECT id, firm_entity_id, fund_entity_id, fund_name, vintage_year,
            target_size_usd, hard_cap_usd, first_close_date, final_close_date,
            announced_raised_usd, mgmt_fee_pct, strategy, fund_status
       FROM funds WHERE id = ?`,
  ).bind(fundId).first<FundRow>();
  if (!fund) return null;

  const defaults = defaultsFor(fund.strategy);
  const assumptions: string[] = [];

  // ---- total_raised: max(announced, ΣFormD.amount_sold, ΣLP.committed)
  let total_raised: number | null = fund.announced_raised_usd ?? null;
  let formDSum = 0;
  let lpSum = 0;
  // Form D rows tied to this firm's filings whose issuer matches the
  // fund name. Conservative substring match (assembler already did the
  // strong match).
  const formD = await env.DB.prepare(
    `SELECT COALESCE(SUM(total_amount_sold), 0) AS s
       FROM sec_form_d_rounds
      WHERE lower(issuer_name) LIKE ?`,
  ).bind(`%${fund.fund_name.toLowerCase().slice(0, 60)}%`).first<{ s: number }>();
  formDSum = Number(formD?.s ?? 0);
  if (fund.fund_entity_id) {
    const lp = await env.DB.prepare(
      `SELECT COALESCE(SUM(committed_usd), 0) AS s
         FROM lp_fund_commitments WHERE fund_entity_id = ?`,
    ).bind(fund.fund_entity_id).first<{ s: number }>();
    lpSum = Number(lp?.s ?? 0);
  }
  const totals = [total_raised ?? 0, formDSum, lpSum].filter((n) => n > 0);
  if (totals.length > 0) total_raised = Math.max(...totals);

  if (total_raised == null || total_raised <= 0) {
    assumptions.push("no total_raised signal (ADV gross_asset_value, Form D amount_sold, LP committed all missing)");
    return {
      fund_id: fund.id,
      total_raised_usd: null,
      deployed_low_usd: 0, deployed_mid_usd: 0, deployed_high_usd: 0,
      estimated_fees_usd: 0, estimated_reserves_usd: 0,
      low: 0, mid: 0, high: 0,
      assumptions,
    };
  }
  assumptions.push(`total_raised = max(announced=${fund.announced_raised_usd ?? 0}, formD_amount_sold=${formDSum}, lp_committed=${lpSum})`);

  // ---- deployed: deals where firm participated within [first_close, today]
  const fromDate = fund.first_close_date ?? `${(fund.vintage_year ?? new Date().getFullYear() - 10)}-01-01`;
  const participations = await env.DB.prepare(
    `SELECT d.id AS deal_id, d.amount_usd, p.role,
            COALESCE(d.announcement_date, d.closing_date) AS date
       FROM deal_events d
       JOIN deal_participants p ON p.deal_id = d.id
      WHERE p.investor_entity_id = ?
        AND COALESCE(d.announcement_date, d.closing_date) >= ?
        AND d.event_type = 'funding_round'
      ORDER BY date DESC
      LIMIT 1000`,
  ).bind(fund.firm_entity_id, fromDate).all<ParticipationRow>();

  let deployed_mid = 0;
  let deployed_low = 0;
  let deployed_high = 0;
  for (const p of participations.results ?? []) {
    if (p.amount_usd == null || p.amount_usd <= 0) continue;
    const sharePctMid = p.role === "lead" ? defaults.lead_share_pct : defaults.participant_share_pct;
    deployed_mid += p.amount_usd * sharePctMid;
    deployed_low += p.amount_usd * sharePctMid * 0.6;
    deployed_high += p.amount_usd * sharePctMid * 1.4;
  }
  assumptions.push(
    `deployed share assumptions (strategy=${fund.strategy ?? "unknown"}): ` +
    `lead=${(defaults.lead_share_pct * 100).toFixed(0)}%, ` +
    `participant=${(defaults.participant_share_pct * 100).toFixed(0)}%, ` +
    `low/high = mid × {0.6, 1.4}`,
  );
  assumptions.push(`firm participated in ${(participations.results ?? []).length} funding rounds since ${fromDate}`);

  // ---- fees: mgmt fee × years_since_first_close × committed
  const yearsSinceClose = fund.first_close_date
    ? Math.max(0, (Date.now() - Date.parse(fund.first_close_date)) / (1000 * 60 * 60 * 24 * 365.25))
    : 0;
  const feePct = (fund.mgmt_fee_pct != null && fund.mgmt_fee_pct > 0)
    ? fund.mgmt_fee_pct / 100
    : defaults.fee_pct_annual;
  const estimated_fees = total_raised * feePct * Math.min(yearsSinceClose, 10);
  assumptions.push(
    `estimated_fees = total_raised × ${(feePct * 100).toFixed(2)}%/yr × ${yearsSinceClose.toFixed(1)}yrs (capped 10yr)`,
  );

  // ---- reserves: % of remaining (post-deployed, post-fees) capital
  // earmarked for follow-ons in already-funded portfolio companies. The
  // spec treats reserves as "committed but not yet deployable for new
  // deals" — i.e. they reduce *new-deal* dry powder. The low band
  // applies the strategy reserve_pct; the high band assumes zero
  // additional reserves (fund chooses not to follow on); mid is the
  // half-way point. This widens the band as the spec requires.
  const remainingAfterMid  = Math.max(0, total_raised - deployed_mid  - estimated_fees);
  const remainingAfterLow  = Math.max(0, total_raised - deployed_high - estimated_fees * 1.2);
  const remainingAfterHigh = Math.max(0, total_raised - deployed_low  - estimated_fees * 0.8);
  const estimated_reserves = remainingAfterMid * defaults.reserve_pct * 0.5;
  assumptions.push(
    `estimated_reserves = remaining_after_mid × ${(defaults.reserve_pct * 100).toFixed(0)}% × 0.5 ` +
    `(low band uses full reserve_pct; high band uses 0% — reserves reduce *new-deal* dry powder)`,
  );

  const mid  = Math.round(remainingAfterMid  - estimated_reserves);
  const low  = Math.round(remainingAfterLow  * (1 - defaults.reserve_pct));
  const high = Math.round(remainingAfterHigh);

  return {
    fund_id: fund.id,
    total_raised_usd: total_raised,
    deployed_low_usd: deployed_low,
    deployed_mid_usd: deployed_mid,
    deployed_high_usd: deployed_high,
    estimated_fees_usd: estimated_fees,
    estimated_reserves_usd: estimated_reserves,
    low: Math.round(low),
    mid: Math.round(mid),
    high: Math.round(high),
    assumptions,
  };
}
