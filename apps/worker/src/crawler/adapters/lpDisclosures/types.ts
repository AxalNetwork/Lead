// Task #2: LP disclosure adapter shared types.
//
// Adapters are PURE EXTRACTORS — they take (text/html, url, ctx) and
// return a normalized list of fund-commitment candidates. The crawler
// engine has already fetched the page (PDFs are pre-converted to text
// upstream by the fetch tier); adapters never make network calls or DB
// writes.

export type LpClass =
  | "pension"
  | "endowment"
  | "foundation"
  | "sovereign"
  | "family_office"
  | "other";

/**
 * One row in a fund-by-fund commitment table. Numeric fields are
 * post-parse: dollar amounts are USD whole-dollars (no thousands /
 * millions multiplier — the parser applies the table's unit hint).
 * Percent fields are 0..100 (e.g. 18.4 for 18.4%, NOT 0.184).
 */
export interface LpCommitmentCandidate {
  fund_name_raw: string;
  vintage_year: number | null;
  committed_usd: number | null;
  called_usd: number | null;
  distributed_usd: number | null;
  nav_usd: number | null;
  net_irr_pct: number | null;
  tvpi: number | null;
  dpi: number | null;
  /** Optional GP / firm hint extracted from the row, when the
   *  disclosure surfaces a separate manager column. */
  gp_firm_hint?: string | null;
}

/** Adapter-emitted payload that the persist layer consumes. */
export interface LpDisclosurePayload {
  /** LP identifier the adapter is bound to. Slugs are stable strings
   *  (e.g. "calpers", "harvard_endowment") used as the LP-side join
   *  key. The persist layer maps slug → u_entities.id via the LP
   *  registry, creating the LP entity on first encounter. */
  lp_slug: string;
  lp_display_name: string;
  lp_class: LpClass;
  /** Period end the disclosure measures. ISO date. */
  as_of_date: string | null;
  /** Date the report was published. ISO date. */
  filing_date: string | null;
  /** Disclosure document URL (PDF / HTML). */
  source_url: string;
  commitments: LpCommitmentCandidate[];
}
