// Task #25 binding shapes. Kept loose so absence of an SDK type at compile
// time doesn't block typecheck — DurableObjectNamespace + WorkflowBinding
// types live in @cloudflare/workers-types.
export interface VectorizeIndex {
  query(vector: number[], options?: { topK?: number; returnMetadata?: "all" | "none" | "indexed"; namespace?: string }): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<{ count: number }>;
  deleteByIds(ids: string[]): Promise<{ count: number }>;
  getByIds(ids: string[]): Promise<Array<{ id: string; values?: number[]; metadata?: Record<string, unknown> }>>;
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
  LEAD_QUEUE: Queue<QueueMessage>;
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
  VEC_PROJECTS?: VectorizeIndex;
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
  WF_MATCH_PROJECT?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  // Task #3: DD scan workflows (per-entity + batch).
  WF_DD_SCAN_ENTITY?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_DD_SCAN_BATCH?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  AI_DAILY_NEURONS_CAP?: string;
  VECTORIZE_DAILY_QUERIES_CAP?: string;
  AI_SEARCH_NAMESPACE?: string;
  AI_EXTRACT_MODEL?: string;
  AI_VISION_MODEL?: string;
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

  // ---- Task #3: Due-diligence providers ----
  // Most DD providers are public/free (OpenSanctions, GDELT, SEC EDGAR,
  // CourtListener). UK Companies House reuses UK_CH_API_KEY above.
  // NEWSAPI_KEY is optional and used to augment adverse-media scans.
  NEWSAPI_KEY?: string;

  // ---- Task #2: News ingestion ----
  // newsapi.org key. When set, /news/refresh pulls up to 100 articles
  // per entity per day. Free tier ⇒ 100/day total. Absent ⇒ skip provider.
  NEWS_API_KEY?: string;
  // api.congress.gov key. When set, the regulator crawler pulls federal
  // bill mentions. Absent ⇒ skip provider.
  CONGRESS_API_KEY?: string;
  // Comma-separated language allowlist (ISO 639-1). Default: "en".
  NEWS_LANG_ALLOWLIST?: string;
  // Per-entity per-day cap for /news/refresh. Default: 100.
  NEWS_REFRESH_PER_ENTITY_CAP?: string;
  // Task #2: refresh-news workflow (durable per-entity news pull).
  WF_REFRESH_NEWS?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };

  // ---- Task #3: Profile-type classifier + political/ideology profiler ----
  WF_CLASSIFY_ENTITY?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_CLASSIFY_BATCH?:  { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_REFRESH_GOVERNMENT?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  // ---- Task #2 (this task): link discovery workflows ----
  WF_DISCOVER_FROM_SEED?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_CRAWL_FRONTIER?:     { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  // Set to "off" to disable ideology axes entirely (axes stay NULL).
  CLASSIFIER_IDEOLOGY?: string;
  // ---- Task #3 (this task): conversational research agent ----
  // Optional Anthropic/OpenAI fallback when Workers AI fails / returns
  // malformed JSON. Absent ⇒ Workers-AI-only.
  AGENT_FALLBACK_KEY?: string;
  // Provider for the fallback key: "anthropic" | "openai". Default openai.
  AGENT_FALLBACK_PROVIDER?: string;
  // Per-owner daily token budget. Default 200000.
  AGENT_DAILY_TOKEN_BUDGET?: string;
  // Saved-research nightly refresh workflow.
  WF_REFRESH_SAVED_RESEARCH?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  // FEC + OpenSecrets political-donation source keys (both optional).
  FEC_API_KEY?: string;
  OPENSECRETS_API_KEY?: string;
  // ProPublica Congress (US federal appointments). Optional.
  PROPUBLICA_API_KEY?: string;
  // Toggle the Canadian Open Parliament adapter ("true" to enable).
  OPENPARLIAMENT_ENABLED?: string;
  // Task #2 (monitoring): per-entity monitor + batch sweep + digest.
  WF_MONITOR_ENTITY?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_MONITOR_BATCH?:  { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_DIGEST?:         { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  // Task #3 (this task): cross-platform identity resolution workflows.
  WF_OSINT_RESOLVE_ENTITY?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_OSINT_BATCH?:          { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_OSINT_REVERIFY?:       { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
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

// Task #4: unified queue envelope. Existing crawl/import jobs land as the
// legacy `JobMessage` shape; the queue handler dispatches on shape so new
// message kinds (e.g. entity-summary rebuilds) can ride the same queue.
export interface RebuildSummaryQueueMessage {
  type: "rebuild_summary";
  entityId: string;
}

export type QueueMessage = JobMessage | RebuildSummaryQueueMessage;

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
