// Task #2: Fund-Return Modeling — shared types.

export type EventKind = "ipo" | "acquisition" | "merger" | "bankruptcy" | "unexited";

export interface ProceedsEstimate {
  company_entity_id: string | null;
  company_name: string;
  position_usd: number | null;          // fund's check into the company
  ownership_pct: number | null;         // estimated ownership at exit (0..1)
  event_kind: EventKind;
  event_date: string | null;
  realized_usd: number;                 // distributed back to fund (0 for unexited / bankruptcy)
  residual_usd: number;                 // unrealized value at last mark
  confidence: number;                   // 0..1; drives resolved-coverage score
  source_url: string | null;
  notes: string[];
}

export type Confidence = "high" | "medium" | "low";

export interface FundReturnModel {
  fund_id: string;
  as_of: string;
  model_version: string;
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
  confidence: Confidence;
  bias_correction_applied: number | null;
  delta_vs_actual: Record<string, unknown> | null;
  attribution: AttributionRow[];
  warnings: string[];
}

export interface AttributionRow {
  company_entity_id: string | null;
  company_name: string;
  contribution_usd: number;             // realized + residual
  share_pct: number;                    // contribution / sum
  event_kind: EventKind;
}

export const MODEL_VERSION = "1.0.0";
export const MGMT_FEE_PCT_PER_YEAR = 0.02;
