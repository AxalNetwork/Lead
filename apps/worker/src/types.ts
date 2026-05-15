// Task #25 binding shapes. Kept loose so absence of an SDK type at compile
// time doesn't block typecheck — DurableObjectNamespace + WorkflowBinding
// types live in @cloudflare/workers-types.
export interface VectorizeIndex {
  query(vector: number[], options?: { topK?: number; returnMetadata?: "all" | "none" | "indexed"; namespace?: string }): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<{ count: number }>;
  deleteByIds(ids: string[]): Promise<{ count: number }>;
}
export interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}
export interface ImagesBinding {
  upload(opts: { url?: string; body?: ReadableStream | ArrayBuffer | Uint8Array; metadata?: Record<string, string> }): Promise<{ id: string; variants?: string[] }>;
  delete(id: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  SCRAPE_CACHE: KVNamespace;
  RAW_HTML: R2Bucket;
  UPLOADS: R2Bucket;
  AI_CACHE?: R2Bucket;
  BROWSER?: Fetcher;
  LEAD_QUEUE: Queue<JobMessage>;
  ALLOWED_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_APP_AUD: string;

  // ---- Task #25: Cloudflare-native AI stack (all optional; fallbacks exist) ----
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  VEC_LEADS?: VectorizeIndex;
  VEC_FIRMS?: VectorizeIndex;
  VEC_COMPANIES?: VectorizeIndex;
  VEC_ACCOUNTS?: VectorizeIndex;
  VEC_PERSONAS?: VectorizeIndex;
  ENTITY_LOCK?: DurableObjectNamespace;
  ANALYTICS?: AnalyticsEngineDataset;
  RL_HOST?: RateLimiter;
  RL_AI?: RateLimiter;
  IMAGES?: ImagesBinding;
  WF_ENRICH_LEAD?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_ENRICH_FIRM?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_INGEST_PAGE?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_ENRICH_ACCOUNT?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_CRAWL_SIGNALS?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_RESCORE_PERSONA?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  AI_DAILY_NEURONS_CAP?: string;
  VECTORIZE_DAILY_QUERIES_CAP?: string;
  AI_SEARCH_NAMESPACE?: string;
  AI_EXTRACT_MODEL?: string;
  PERSONA_RESCORE_SECRET?: string;
  AI_EMBED_MODEL?: string;
  AI_OCR_MODEL?: string;
  AI_SEARCH?: Fetcher;
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
  BUILTWITH_API_KEY?: string;
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

export type JobKind =
  | "url"
  | "linktree"
  | "profile_list"
  | "discover"
  | "firmlist"
  | "firm_team_crawl"
  | "parse_file"
  | "import_file";

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
