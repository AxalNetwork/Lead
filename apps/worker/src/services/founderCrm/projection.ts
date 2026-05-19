// Task #5: Public projection for GET /api/investors/:id/reputation.
//
// Pure helper so the min-sample-gate behavior can be unit-tested.
// Below the 5-review threshold, the public projection redacts every
// founder-feedback-derived field. Signals derived from non-feedback
// sources (term_aggressiveness_pct, follow_on_rate_pct) remain
// visible because they come from public data (SEC filings + Form D)
// and are not bound to the feedback sample-size gate.

export interface RawReputationRow {
  investor_entity_id: string;
  speed_to_no_days_median: number | null;
  term_aggressiveness_pct: number | null;
  follow_on_rate_pct: number | null;
  board_behavior_score: number | null;
  founder_nps: number | null;
  reneged_term_sheets_count: number;
  portfolio_conflict_count: number;
  sample_size: number;
  speed_to_no_n: number;
  follow_on_n: number;
  is_public: number;
  low_sample: number;
  computed_at: string;
}

export interface PublicReputation {
  investor_entity_id: string;
  speed_to_no_days_median: number | null;
  term_aggressiveness_pct: number | null;
  follow_on_rate_pct: number | null;
  board_behavior_score: number | null;
  founder_nps: number | null;
  reneged_term_sheets_count: number | null;
  portfolio_conflict_count: number;
  sample_size: number;
  is_public: boolean;
  low_sample: boolean;
  redacted_fields: string[];
  computed_at: string;
}

/** Project a reputation row for the public read API. When
 *  is_public=0, every feedback-derived field is nulled and listed
 *  in `redacted_fields` so the UI can render a "needs more reviews"
 *  badge instead of misleading zeros. Admin callers see the raw row
 *  via a separate code path (this projection is for public reads). */
export function projectPublicReputation(row: RawReputationRow): PublicReputation {
  const isPublic = row.is_public === 1;
  const redacted: string[] = [];
  const redactIfPrivate = <T>(v: T, name: string): T | null => {
    if (isPublic) return v;
    redacted.push(name);
    return null;
  };
  return {
    investor_entity_id: row.investor_entity_id,
    speed_to_no_days_median: redactIfPrivate(row.speed_to_no_days_median, "speed_to_no_days_median"),
    // term_aggressiveness_pct + follow_on_rate_pct are derived from
    // SEC filings / Form D (Task #18 + deal_participants) — they are
    // PUBLIC data and never gated by the feedback sample size.
    term_aggressiveness_pct: row.term_aggressiveness_pct,
    follow_on_rate_pct: row.follow_on_rate_pct,
    board_behavior_score: redactIfPrivate(row.board_behavior_score, "board_behavior_score"),
    founder_nps: redactIfPrivate(row.founder_nps, "founder_nps"),
    reneged_term_sheets_count: redactIfPrivate(row.reneged_term_sheets_count, "reneged_term_sheets_count"),
    portfolio_conflict_count: row.portfolio_conflict_count,
    sample_size: row.sample_size,
    is_public: isPublic,
    low_sample: row.low_sample === 1,
    redacted_fields: redacted,
    computed_at: row.computed_at,
  };
}
