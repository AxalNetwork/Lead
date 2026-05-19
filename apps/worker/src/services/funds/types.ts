// Task #3: Fund Intelligence Engine — shared types.

export type FundStrategy =
  | "seed" | "early" | "growth" | "late"
  | "buyout" | "growth_equity" | "secondary"
  | "fund_of_funds" | "credit";

export type FundStatus = "raising" | "active" | "harvesting" | "wound_down";

export type FundSourceType =
  | "sec_filing"
  | "company_blog"
  | "press_release"
  | "tech_press"
  | "lp_disclosure"
  | "firm_site";

/** Source-authority hierarchy — higher = more authoritative. Mirrors
 *  the deal-aggregator hierarchy. */
export const FUND_AUTHORITY: Record<FundSourceType, number> = {
  sec_filing:    100,
  company_blog:  80,
  firm_site:     70,
  lp_disclosure: 65,
  press_release: 50,
  tech_press:    30,
};

export interface FundEvidence {
  field: string;
  value: unknown;
  source_type: FundSourceType;
  source_url: string | null;
  observed_at: string;
}

export interface FundRow {
  id: string;
  firm_entity_id: string;
  fund_entity_id: string | null;
  fund_name: string;
  fund_number: number | null;
  vintage_year: number | null;
  target_size_usd: number | null;
  hard_cap_usd: number | null;
  first_close_date: string | null;
  final_close_date: string | null;
  announced_raised_usd: number | null;
  gp_commit_usd: number | null;
  mgmt_fee_pct: number | null;
  carry_pct: number | null;
  hurdle_pct: number | null;
  strategy: FundStrategy | null;
  sectors_json: string | null;
  geos_json: string | null;
  fund_status: FundStatus;
  source_evidence_json: string | null;
  confidence: number;
  updated_at: string;
  created_at: string;
}

export interface DryPowderBand {
  fund_id: string;
  total_raised_usd: number | null;
  deployed_low_usd: number;
  deployed_mid_usd: number;
  deployed_high_usd: number;
  estimated_fees_usd: number;
  estimated_reserves_usd: number;
  low: number;
  mid: number;
  high: number;
  assumptions: string[];
}

export interface PortfolioRow {
  fund_id: string;
  company_entity_id: string | null;
  company_name: string;
  round_name: string | null;
  /** Total round size from deal_events.amount_usd or Form D total — used
   *  for round-level analytics and as an ownership-denominator fallback. */
  amount_usd: number | null;
  /** Fund's actual check size from deal_participants.position_usd — the
   *  invested-capital base for fund-return modeling. Null for Form D rows
   *  (no GP-level breakdown disclosed) and for deal_events rows where the
   *  participant row didn't carry a check size. */
  position_usd: number | null;
  role: "lead" | "participating" | "follow_on" | "unknown";
  date: string | null;
  sector_tags: string[];
  geography: string | null;
  source_kind: "deal_event" | "form_d";
}
