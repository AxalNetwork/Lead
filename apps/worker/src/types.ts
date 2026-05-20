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
  // Task #2 bug-triage: reserved bindings for upcoming tasks. Declared
  // here + in wrangler.toml so a reference in Task #57 / #43 code can't
  // typecheck against `undefined`.
  IMPORTS?: R2Bucket;
  TRANSCRIPTS?: R2Bucket;
  BROWSER?: Fetcher;
  LEAD_QUEUE: Queue<QueueMessage>;
  ALLOWED_EMAIL: string;
  // Task #2: comma-separated allowlist of admin emails (for
  // /api/ops/* and /ops/crawler). When unset, ALLOWED_EMAIL is
  // treated as admin so the single-operator deployment works
  // out of the box.
  ADMIN_EMAILS?: string;
  // Task #2 bug-triage: explicit prod/debug flags so the error envelope
  // can strip Error.stack in production.
  ENVIRONMENT?: string;
  DEBUG?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_APP_AUD: string;

  // Task #5: per-deployment secret salt for the anonymous founder
  // feedback submitter_hash. When unset, POST /api/founder-feedback
  // returns 503 (honest degradation — never fall back to a fake or
  // empty salt that would weaken anonymity guarantees).
  FOUNDER_FEEDBACK_SALT?: string;

  // ---- Task #25: Cloudflare-native AI stack (all optional; fallbacks exist) ----
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  VEC_LEADS?: VectorizeIndex;
  VEC_FIRMS?: VectorizeIndex;
  VEC_COMPANIES?: VectorizeIndex;
  VEC_ACCOUNTS?: VectorizeIndex;
  VEC_PERSONAS?: VectorizeIndex;
  VEC_PROJECTS?: VectorizeIndex;
  // Task #2 bug-triage: unified entity-graph vector index used by
  // Tasks #7 / #8 / #9 persona ↔ entity matching.
  VECTORIZE_ENTITIES?: VectorizeIndex;
  ENTITY_LOCK?: DurableObjectNamespace;
  // Task #1: per-host politeness controller (one DO per domain).
  HOST_THROTTLE?: DurableObjectNamespace;
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
  // Task #8: persona ↔ entity matching against the unified u_entities graph.
  WF_PERSONA_ENTITY_MATCH?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_PERSONA_MATCH_REFRESH?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_PERSONA_MATCH_ENTITY?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_MATCH_PROJECT?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  // Task #3: DD scan workflows (per-entity + batch).
  WF_DD_SCAN_ENTITY?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_DD_SCAN_BATCH?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  AI_DAILY_NEURONS_CAP?: string;
  VECTORIZE_DAILY_QUERIES_CAP?: string;
  AI_SEARCH_NAMESPACE?: string;
  AI_EXTRACT_MODEL?: string;
  // Task #1: feature flag gating per-profile-type workflow dispatch in
  // the URL pipeline. "1" = enabled. Off by default so the change is
  // strictly additive until an operator opts in.
  PROFILE_WORKFLOWS_ENABLED?: string;
  AI_VISION_MODEL?: string;
  PERSONA_RESCORE_SECRET?: string;
  AI_EMBED_MODEL?: string;
  AI_OCR_MODEL?: string;
  AI_SEARCH?: Fetcher;
  // Fetcher tier secrets (all optional; absent ⇒ tier is skipped).
  PROXY_URL?: string;
  COURTLISTENER_TOKEN?: string;
  PACER_USER?: string;
  PACER_PASS?: string;
  COMPANIES_HOUSE_API_KEY?: string;
  PROXY_AUTH?: string;
  // Task #5: SCRAPER_API_*, BRAVE_*, HUNTER_*, APOLLO_*, ROCKETREACH_*,
  // PEOPLEDATALABS_*, PROXYCURL_*, CRUNCHBASE_*, OPENCORPORATES_*,
  // UK_CH_*, WHOISXML_*, FORBES_SIGNALS_*, BUILTWITH_* env keys were
  // removed when the 13 paid third-party APIs were ripped out.

  // ---- Enrichment providers (each missing key disables that provider) ----
  SEC_EDGAR_UA?: string;     // SEC requires a User-Agent

  // ---- Per-provider daily USD caps (strings parsed at read time) ----
  SEC_EDGAR_DAILY_USD?: string;
  TWITTER_OSS_DAILY_USD?: string;

  // ---- Misc enrichment ----
  ENRICHMENT_KV_TTL_DAYS?: string; // default 14
  NITTER_BASE?: string;            // default https://nitter.net

  // ---- Task #3: Due-diligence providers ----
  // Most DD providers are public/free (OpenSanctions, GDELT, SEC EDGAR,
  // CourtListener). UK Companies House now uses a keyless public-HTML
  // path (Task #5). NEWSAPI_KEY is optional and used to augment
  // adverse-media scans.
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
  // Task #3 (this task): Workers-AI Profile Filler.
  WF_PROFILE_FILLER?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  WF_PROFILE_FILLER_BATCH?: { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
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
  // Task #5: per-entity individual profiler workflow (30+ enrichers).
  WF_PROFILER_INDIVIDUAL?:  { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  // Task #3: durable per-import CSV pipeline for >5,000 row files.
  WF_CSV_IMPORT?:           { create: (opts: { params: Record<string, unknown> }) => Promise<{ id: string }> };
  // Task #5 (System Health): optional Slack webhook for hard-threshold
  // alerts. When unset, alerts still fire to ALLOWED_EMAIL — Slack is
  // a secondary channel only.
  SLACK_WEBHOOK_URL?: string;
}

export type JobKind =
  | "url"
  | "linktree"
  | "profile_list"
  | "discover"
  | "firmlist"
  | "firm_team_crawl"
  | "parse_file"
  | "import_file"
  // Task #3 (spec contract): CSV-only end-to-end pipeline. Backed by
  // `csv_imports` table + processCsvImport handler. Kept separate from
  // `parse_file`/`import_file` (the multi-format file_imports pipeline)
  // so the spec contract `{type:'csv_import', import_id}` works
  // unchanged for external producers.
  | "csv_import";

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

// Task #3 spec envelope: external producers may enqueue
// {type:'csv_import', import_id} directly without constructing the
// legacy JobMessage. The queue dispatcher in index.ts recognizes this
// shape and routes to processCsvImport with a synthetic JobMessage
// so the audit trail (jobs row, markCompleted/markFailed) stays
// consistent with the rest of the pipeline.
export interface CsvImportEnvelopeMessage {
  type: "csv_import";
  import_id: string;
}

export type QueueMessage = JobMessage | RebuildSummaryQueueMessage | CsvImportEnvelopeMessage;

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
