// Task #3: Deal-aggregator typed payloads.
//
// A DealCandidate is the contract emitted by every source path:
//   - press-wire / tech-press RSS adapters (heuristic + AI extraction)
//   - SEC EDGAR persist (synthesized from Form D / 8-K)
//   - company blog crawls (future)
//
// The persist layer (services/deals/persist.ts) is the only writer of
// `deal_events` / `deal_participants` and handles dedupe, corroboration,
// and source-authority arbitration.

export type DealEventType =
  | "funding_round"
  | "acquisition"
  | "merger"
  | "ipo"
  | "secondary"
  | "spinout"
  | "recapitalization"
  | "bankruptcy";

export type DealRoundName =
  | "Pre-Seed" | "Seed"
  | "Series A" | "Series B" | "Series C" | "Series D" | "Series E"
  | "Series F" | "Series G" | "Series H"
  | "Bridge" | "Extension" | "PIPE";

export type DealValuationType = "pre_money" | "post_money" | "unknown";

/** Authority hierarchy: SEC > company blog > press release > tech press. */
export type DealSourceType =
  | "sec_filing"
  | "company_blog"
  | "press_release"
  | "tech_press";

export type DealParticipantRole = "lead" | "participating" | "follow_on";

export interface DealParticipantInput {
  investor_name_raw: string;
  role: DealParticipantRole;
  position_usd?: number | null;
}

export interface DealCandidate {
  event_type: DealEventType;
  company_name_raw: string;
  company_website?: string | null;
  round_name?: DealRoundName | null;
  amount_usd?: number | null;
  amount_raw?: string | null;
  valuation_usd?: number | null;
  valuation_type?: DealValuationType | null;
  lead_investors: string[];
  participating_investors: string[];
  announcement_date?: string | null;     // ISO date
  closing_date?: string | null;          // ISO date
  sector_tags?: string[];
  stage_tags?: string[];
  geography?: string | null;
  use_of_proceeds?: string | null;
  source_url: string;
  source_type: DealSourceType;
  source_published_at?: string | null;
  /** 0..1 extractor confidence. < 0.2 means schema-strict gate failed and
   *  the row MUST NOT be persisted (spec: "no silent coercion"). */
  confidence: number;
}
