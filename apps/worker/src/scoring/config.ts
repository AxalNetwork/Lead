// Lead quality scoring weights and tunables. The score is a 0..1 number that
// is also exposed as a 0..100 integer in dashboard widgets.
export const QUALITY_WEIGHTS = {
  completeness: 0.30,
  verification: 0.20,
  corroboration: 0.15,
  freshness: 0.15,
  persona_match: 0.10,
  track_record: 0.10,
} as const;

// Fields that count toward "completeness". One point each, normalized.
export const COMPLETENESS_FIELDS = [
  "name", "email", "org", "title", "phone", "linkedin_url",
  "country_iso2", "city", "persona_role", "seniority", "bio",
] as const;

// Fields that count toward "track record". Each non-empty JSON array adds a point.
export const TRACK_RECORD_FIELDS = [
  "companies_json", "board_seats_json", "awards_json", "exits_json",
] as const;

// Freshness halves every FRESHNESS_HALFLIFE_DAYS of staleness, floored at 0.
export const FRESHNESS_HALFLIFE_DAYS = 30;

// Funnel statuses, in order. Used by /leads/funnel and the dashboard widget.
export const FUNNEL_STATUSES = [
  "new", "enriched", "verified", "pending",
  "approved", "contacted", "replied", "meeting",
] as const;
export type FunnelStatus = (typeof FUNNEL_STATUSES)[number];
