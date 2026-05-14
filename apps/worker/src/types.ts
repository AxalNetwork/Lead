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
  PROXY_URL?: string;             // e.g. https://proxy.example.com:8443
  PROXY_AUTH?: string;            // "user:pass" basic auth for the proxy
  SCRAPER_API_KEY?: string;
  SCRAPER_API_PROVIDER?: string;  // "scraperapi" | "scrapingbee" | "zenrows"
}

export type JobKind = "url" | "linktree" | "profile_list";

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
