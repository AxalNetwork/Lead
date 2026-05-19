// Task #5: Cap-Table inference shared types.
//
// One CapTableSnapshotInput per (company, as_of, source) extraction
// pass. The persist layer (services/capTable/persist.ts) is the only
// writer of cap_table_snapshots / cap_table_holders and is the only
// place that resolves holders → u_entities + writes derived facts via
// `insertFact`.

export type CapTableSourceKind =
  | "s1_filing"
  | "delaware_coi"
  | "form_d_inference"
  | "secondary_listing"
  | "press_inference";

export type HolderClass =
  | "founder"
  | "preferred_investor"
  | "common_investor"
  | "employee_pool"
  | "esop_unallocated"
  | "unknown";

export type SecurityType =
  | "common"
  | "preferred"           // unspecified series
  | "preferred_a" | "preferred_b" | "preferred_c" | "preferred_d"
  | "preferred_e" | "preferred_f" | "preferred_g" | "preferred_h"
  | "option"
  | "warrant"
  | "safe"
  | "convertible_note"
  | "unknown";

export interface CapTableHolderInput {
  holder_name_raw: string;
  holder_class?: HolderClass;
  security_type?: SecurityType | null;
  shares?: number | null;
  pct_ownership?: number | null;       // 0..1
  original_investment_usd?: number | null;
  round_acquired?: string | null;
  liquidation_preference_x?: number | null;
  participating?: boolean | null;
  notes?: string | null;
}

export interface CapTableSnapshotInput {
  company_entity_id?: string | null;   // when caller already resolved it
  company_name_raw: string;
  as_of: string;                       // ISO date YYYY-MM-DD
  source_kind: CapTableSourceKind;
  source_url: string;
  source_accession_no?: string | null;
  fully_diluted_shares?: number | null;
  post_money_usd?: number | null;
  pre_money_usd?: number | null;
  option_pool_pct?: number | null;     // 0..1
  preferred_pct?: number | null;
  common_pct?: number | null;
  confidence?: number;                 // overrides default per source_kind
  notes?: string | null;
  holders: CapTableHolderInput[];
}

export interface CapTablePersistResult {
  snapshot_id: string | null;
  company_entity_id: string | null;
  holders_written: number;
  skipped: boolean;
  reason?: string;
}

/** Default per-source confidence (see migration 359 header). */
export const DEFAULT_CONFIDENCE: Record<CapTableSourceKind, number> = {
  s1_filing: 0.95,
  delaware_coi: 0.70,
  form_d_inference: 0.55,
  secondary_listing: 0.50,
  press_inference: 0.30,
};
