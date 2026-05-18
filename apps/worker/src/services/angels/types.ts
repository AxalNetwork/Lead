// Task #4: Angel & Syndicate types and source-authority hierarchy.

export type AngelType =
  | "solo_capitalist"
  | "operator_angel"
  | "super_angel"
  | "syndicate_lead"
  | "rolling_fund_manager"
  | "casual_angel";

export type AngelSourceType =
  | "sec_filing"
  | "company_blog"
  | "press_release"
  | "tech_press"
  | "crunchbase"
  | "angellist"
  | "social_bio"
  | "newsletter";

/** Per-spec source hierarchy: SEC > company > press > tech press > social bio. */
export const ANGEL_AUTHORITY: Record<AngelSourceType, number> = {
  sec_filing:    100,
  company_blog:  80,
  angellist:     70,
  crunchbase:    65,
  press_release: 50,
  tech_press:    30,
  newsletter:    25,
  social_bio:    15,
};

export interface AngelEvidence {
  field: string;
  value: unknown;
  source_type: AngelSourceType;
  source_url: string | null;
  observed_at: string;
}

export interface DomainExpertiseTag {
  tag: string;
  source: "day_job_firm" | "role" | "investment_pattern";
  evidence_url?: string | null;
}

export interface AngelRow {
  person_entity_id: string;
  angel_type: AngelType | null;
  classifier_confidence: number | null;
  day_job_entity_id: string | null;
  day_job_role: string | null;
  typical_check_min_usd: number | null;
  typical_check_max_usd: number | null;
  preferred_stages_json: string | null;
  preferred_sectors_json: string | null;
  preferred_geos_json: string | null;
  portfolio_count: number;
  disclosed_investments_count: number;
  syndicate_handle: string | null;
  rolling_fund_handle: string | null;
  domain_expertise_tags_json: string | null;
  last_investment_at: string | null;
  open_to_warm_intros: number;
  source_evidence_json: string | null;
  confidence: number;
  updated_at: string;
  created_at: string;
  last_refreshed_at: string | null;
}

export interface AngelInvestmentRow {
  id: string;
  person_entity_id: string;
  company_entity_id: string | null;
  company_name_raw: string;
  amount_usd: number | null;
  round_name: string | null;
  role: "lead" | "participant" | "follow_on";
  via_syndicate_handle: string | null;
  announced_at: string | null;
  observed_at: string;
  source_url: string | null;
  source_type: AngelSourceType | null;
  dedupe_key: string;
  deal_event_id: string | null;
  confidence: number;
}

export interface SyndicateRow {
  handle: string;
  display_name: string | null;
  lead_angel_entity_id: string | null;
  focus_sectors_json: string | null;
  focus_stages_json: string | null;
  geos_json: string | null;
  backer_count: number;
  deals_count: number;
  last_deal_at: string | null;
  avg_raise_usd: number | null;
  median_check_usd: number | null;
  velocity_per_quarter: number | null;
  source_evidence_json: string | null;
  updated_at: string;
  created_at: string;
}
