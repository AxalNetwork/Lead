// Task #44: typed allowlist of signal kinds.
//
// Signals are buying-intent or fit events attached to an account. The
// `kind` column on the `signals` table is free text in SQLite but every
// insert path runs through `assertSignalKind` so callers cannot persist
// kinds outside this set. The signal-source crawlers (Greenhouse, Lever,
// Ashby, HN, G2, BuiltWith, etc.) ship as their own follow-up but each
// will land its detected events using a kind from this list.

export const SIGNAL_KINDS = [
  // ---- Hiring / job posting signals ----
  "hiring_role",
  "hiring_burst",
  "hiring_pause",
  "leadership_change",
  "team_expansion",

  // ---- Funding / financial signals ----
  "funding_round",
  "valuation_change",
  "ipo_filing",
  "acquisition",
  "layoffs",
  "revenue_milestone",

  // ---- Tech / product signals ----
  "tech_install",
  "tech_uninstall",
  "product_launch",
  "rebrand",
  "domain_change",

  // ---- Engagement / intent signals ----
  "website_visit",
  "demo_request",
  "content_download",
  "newsletter_signup",
  "review_posted",
  "review_compare",
  "intent_keyword",
  "social_engagement",

  // ---- News / external mentions ----
  "press_mention",
  "podcast_mention",
  "conference_talk",
  "partnership_announce",
  "regulatory_event",

  // ---- Manual ----
  "manual",
] as const;

export type SignalKind = typeof SIGNAL_KINDS[number];

const SET = new Set<string>(SIGNAL_KINDS);

export function isSignalKind(x: unknown): x is SignalKind {
  return typeof x === "string" && SET.has(x);
}

export function assertSignalKind(x: unknown): SignalKind {
  if (!isSignalKind(x)) {
    throw new Error(`invalid_signal_kind:${String(x)}`);
  }
  return x;
}

// Default per-kind weight (1..10). The signal insert path lets the caller
// override but falls back here so unknown-but-allowlisted kinds still get
// a sensible decay contribution.
export const DEFAULT_WEIGHT: Record<SignalKind, number> = {
  hiring_role: 3,
  hiring_burst: 6,
  hiring_pause: 2,
  leadership_change: 7,
  team_expansion: 4,
  funding_round: 8,
  valuation_change: 5,
  ipo_filing: 9,
  acquisition: 9,
  layoffs: 4,
  revenue_milestone: 5,
  tech_install: 6,
  tech_uninstall: 4,
  product_launch: 5,
  rebrand: 3,
  domain_change: 2,
  website_visit: 2,
  demo_request: 9,
  content_download: 4,
  newsletter_signup: 3,
  review_posted: 5,
  review_compare: 7,
  intent_keyword: 4,
  social_engagement: 2,
  press_mention: 3,
  podcast_mention: 3,
  conference_talk: 4,
  partnership_announce: 5,
  regulatory_event: 4,
  manual: 5,
};
