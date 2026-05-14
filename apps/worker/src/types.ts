export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  SCRAPE_CACHE: KVNamespace;
  RAW_HTML: R2Bucket;
  BROWSER?: Fetcher;
  LEAD_QUEUE: Queue<JobMessage>;
  ALLOWED_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_APP_AUD: string;
  // Fetcher tier secrets (all optional; absent ⇒ tier is skipped).
  PROXY_URL?: string;
  PROXY_AUTH?: string;
  SCRAPER_API_KEY?: string;
  SCRAPER_API_PROVIDER?: string;
  BRAVE_API_KEY?: string;
  BRAVE_SEARCH_KEY?: string;

  // ---- Enrichment providers (each missing key disables that provider) ----
  HUNTER_API_KEY?: string;
  APOLLO_API_KEY?: string;
  ROCKETREACH_API_KEY?: string;
  PEOPLEDATALABS_API_KEY?: string;
  PROXYCURL_API_KEY?: string;
  CRUNCHBASE_API_KEY?: string;
  OPENCORPORATES_API_KEY?: string;
  UK_CH_API_KEY?: string;
  WHOISXML_API_KEY?: string;
  FORBES_SIGNALS_KEY?: string;
  SEC_EDGAR_UA?: string;     // SEC requires a User-Agent

  // ---- Per-provider daily USD caps (strings parsed at read time) ----
  HUNTER_DAILY_USD?: string;
  APOLLO_DAILY_USD?: string;
  ROCKETREACH_DAILY_USD?: string;
  PEOPLEDATALABS_DAILY_USD?: string;
  PROXYCURL_DAILY_USD?: string;
  CRUNCHBASE_DAILY_USD?: string;
  SEC_EDGAR_DAILY_USD?: string;
  OPENCORPORATES_DAILY_USD?: string;
  UK_CH_DAILY_USD?: string;
  FORBES_SIGNALS_DAILY_USD?: string;
  WHOISXML_DAILY_USD?: string;
  TWITTER_OSS_DAILY_USD?: string;

  // ---- Misc enrichment ----
  ENRICHMENT_KV_TTL_DAYS?: string; // default 14
  NITTER_BASE?: string;            // default https://nitter.net
}

export type JobKind = "url" | "linktree" | "profile_list" | "discover";

export interface JobMessage {
  jobId: string;
  kind: JobKind;
  target: string;
  config?: Record<string, unknown>;
}

export interface ParsedLead {
  source_domain: string;
  source_url: string;
  name?: string;
  email?: string;
  org?: string;
  title?: string;
  category?: string;
  meta?: Record<string, unknown>;
}
