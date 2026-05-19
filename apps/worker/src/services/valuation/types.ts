// Task #9: Valuation Intelligence shared types.

export type MarkSourceKind =
  | "primary_round"
  | "secondary_listing"
  | "four_oh_nine_a"
  | "mutual_fund_holding"
  | "markdown";

export type MarkKind =
  | "post_money" | "pre_money" | "fmv" | "bid" | "ask" | "mid" | "nav";

export const SOURCE_CONFIDENCE: Record<MarkSourceKind, number> = {
  primary_round: 0.95,
  markdown: 0.85,
  mutual_fund_holding: 0.70,
  secondary_listing: 0.50,
  four_oh_nine_a: 0.40,
};

export interface ValuationMarkInput {
  company_entity_id: string | null;
  company_name_raw: string;
  as_of: string;
  source_kind: MarkSourceKind;
  source_url?: string | null;
  source_ref?: string | null;
  implied_valuation_usd?: number | null;
  share_price_usd?: number | null;
  fully_diluted_shares?: number | null;
  mark_kind?: MarkKind | null;
  confidence?: number | null;
  holder_name_raw?: string | null;
  notes?: string | null;
  raw_evidence?: unknown;
}

export interface ValuationMarkPersistResult {
  mark_id: string | null;
  company_entity_id: string | null;
  skipped: boolean;
  reason?: string;
}

export interface CompPanelCriteria {
  sector?: string | null;
  business_model?: string | null;
  arr_min_usd?: number | null;
  arr_max_usd?: number | null;
  revenue_min_usd?: number | null;
  revenue_max_usd?: number | null;
  growth_min_pct?: number | null;
  growth_max_pct?: number | null;
  geography?: string | null;
}

export interface ImpliedValuationRange {
  panel_id: string | null;
  panel_name: string | null;
  basis: "ev_revenue" | "ev_arr" | "latest_mark" | "none";
  low_usd: number | null;
  median_usd: number | null;
  high_usd: number | null;
  multiple_low: number | null;
  multiple_median: number | null;
  multiple_high: number | null;
  latest_revenue_usd: number | null;
  latest_arr_usd: number | null;
  latest_mark_usd: number | null;
  notes: string | null;
}
