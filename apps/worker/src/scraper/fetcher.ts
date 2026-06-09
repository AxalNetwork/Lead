import type { Env } from "../types";
import { checkRobots } from "./robots";
import { tosBlockedReason } from "./tos";
import { isCircuitOpen, recordFetchOutcome } from "./circuit_breaker";
import { fetchWaybackHtml } from "./fallbacks/wayback";
import { getProxyProviders } from "./proxyPool";
import type { SubrequestBudget } from "./subrequestBudget";
// Task #5: Brave Search cache (tier 5) and paid Scraping API (tier 3) were
// removed. The fetcher now escalates Direct → Browser → Proxy → Wayback,
// which is the supported in-house path.

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

const ACCEPT_LANGS = ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en-CA,en;q=0.9"];

const PLATFORMS = [
  '"macOS"',
  '"Windows"',
  '"Linux"',
];

const CAPTCHA_RE =
  /captcha|cf-mitigated|attention required|access denied|are you a robot|recaptcha|hcaptcha|datadome|perimeterx|akamai bot manager/i;
const BLOCK_STATUSES = new Set([401, 403, 407, 408, 423, 429, 451, 503, 520, 521, 522, 524]);
const MIN_HTML_BYTES = 2048;
const MIN_VISIBLE_TEXT_CHARS = 400;

// Per-tier cost approximations in USD per request. Browser Rendering is billed
// by request; proxy is a rough average used for the health roll-up. Tier 3
// (paid Scraping API) and tier 5 (Brave Search cache) were removed in Task #5
// but the literal slots are retained so persisted fetch_log rows continue to
// typecheck.
const TIER_COST_USD = { 0: 0, 1: 0.0009, 2: 0.0015, 3: 0, 4: 0, 5: 0 } as const;

export type FetchTier = 0 | 1 | 2 | 3 | 4 | 5;

export interface FetchOptions {
  forceBrowser?: boolean;
  /** Per-host minimum interval in milliseconds (default 4000). Robots crawl-delay overrides if larger. */
  minIntervalMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** When set, every attempt gets logged into fetch_log with this job id. */
  jobId?: string;
  /** Allow callers to disable robots/ToS checks for trusted internal URLs. */
  skipPolicy?: boolean;
  /**
   * When true, fetchPage returns the last live tier result without
   * escalating to Wayback (tier 4). Used by team-path probes which
   * require a verified live response — a missing /team page must NOT
   * be satisfied from an archived snapshot, since that would feed
   * stale people into the crawl.
   */
  liveOnly?: boolean;
  /** Extra request headers merged on top of buildHeaders(). Used by
   *  authenticated REST API calls (e.g. CourtListener Token, Companies
   *  House Basic) so they inherit rate-limiting + retry + tiering. */
  headers?: Record<string, string>;
  /** Skip the HTML-anti-bot heuristics (too_small / low_visible_text /
   *  captcha-regex). Required for structured JSON API endpoints whose
   *  valid responses are short or contain none of the visible-text
   *  HTML markers. Only `status_<4xx/5xx>` blocking still applies. */
  expectJson?: boolean;
  /** HTTP method. Defaults to GET. Non-GET requests are tier-0 only —
   *  browser-render and HTTP-forward proxy tiers can't replay POST
   *  bodies reliably, so escalation is suppressed. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Request body for non-GET requests. */
  body?: string;
  /** Task #70: per-invocation subrequest budget shared across the queue
   *  batch. When provided, fetchPage/fetchBytes pre-emptively refuse (and
   *  surface `subrequest_budget_exhausted`) once spending another fetch
   *  would cross the ceiling, and each tier attempt is charged against it.
   *  Omitted by tests and non-crawl callers — then fetching is unbudgeted
   *  (the historical behaviour). */
  budget?: SubrequestBudget;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  html: string;
  bytes: number;
  durationMs: number;
  tier: FetchTier;
  blockReason: string | null;
  /** "live" for normal tiers, "wayback" for archived snapshots. */
  fetched_from: "live" | "wayback";
}

function pickRandom<T>(arr: readonly T[]): T {
  if (arr.length === 0) {
    throw new Error("pickRandom: empty array");
  }
  const item = arr[Math.floor(Math.random() * arr.length)];
  if (item === undefined) {
    throw new Error("pickRandom: unexpected undefined element");
  }
  return item;
}

interface RateLimitState {
  lastFetchedAt: number;
}

async function waitForRateLimit(env: Env, host: string, minIntervalMs: number): Promise<void> {
  // Task #25 step 6: prefer the Cloudflare Rate Limiter binding when
  // configured. On RL_HOST burst rejection we fall back to the legacy KV
  // pacing so we still throttle when the RL binding is missing or returns
  // {success:false}.
  if (env.RL_HOST) {
    try {
      const r = await env.RL_HOST.limit({ key: host });
      if (r.success) return; // RL accepted — no extra wait needed
    } catch {
      // fall through to KV pacer
    }
  }
  const key = `rl:${host}`;
  const raw = await env.SCRAPE_CACHE.get(key);
  const now = Date.now();
  if (raw) {
    try {
      const state = JSON.parse(raw) as RateLimitState;
      const wait = state.lastFetchedAt + minIntervalMs - now;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
    } catch {
      // fall through
    }
  }
  const next: RateLimitState = { lastFetchedAt: Date.now() };
  await env.SCRAPE_CACHE.put(key, JSON.stringify(next), { expirationTtl: 3600 });
}

// Task #2 — HTML replay cache. Successful fetchPage() writes the body
// into SCRAPE_CACHE under html:<sha256(url)>. The ops console replays
// extractions against this cached snapshot (no live network), per the
// "replay from cached HTML without commit" requirement.
const HTML_CACHE_MAX_BYTES = 512 * 1024;
const HTML_CACHE_TTL_SECONDS = 7 * 24 * 3600;
async function htmlCacheKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `html:${hex}`;
}
export async function cacheHtmlForReplay(env: Env, url: string, html: string | undefined | null): Promise<void> {
  if (!html || typeof html !== "string") return;
  if (html.length > HTML_CACHE_MAX_BYTES) return;
  try {
    const key = await htmlCacheKey(url);
    await env.SCRAPE_CACHE.put(key, html, { expirationTtl: HTML_CACHE_TTL_SECONDS });
  } catch { /* best-effort */ }
}
export async function readCachedHtml(env: Env, url: string): Promise<string | null> {
  try {
    const key = await htmlCacheKey(url);
    return (await env.SCRAPE_CACHE.get(key)) ?? null;
  } catch { return null; }
}

function visibleTextLength(html: string): number {
  // Strip script/style blocks, then collapse all tags. Cheap heuristic; enough
  // to detect skeleton "loading" pages and JS-rendered shells.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length;
}

function detectBlockReason(status: number, body: string): string | null {
  if (BLOCK_STATUSES.has(status)) return `status_${status}`;
  if (CAPTCHA_RE.test(body)) return "captcha";
  if (body.length < MIN_HTML_BYTES) return "too_small";
  if (visibleTextLength(body) < MIN_VISIBLE_TEXT_CHARS) return "low_visible_text";
  return null;
}

async function logAttempt(
  env: Env,
  jobId: string | undefined,
  host: string,
  url: string,
  result: { tier: FetchTier; status: number; bytes: number; blockReason: string | null; durationMs: number },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO fetch_log (job_id, host, url, tier, status, bytes, block_reason, duration_ms, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        jobId ?? null,
        host,
        url,
        result.tier,
        result.status,
        result.bytes,
        result.blockReason,
        result.durationMs,
        TIER_COST_USD[result.tier] ?? 0,
        new Date().toISOString(),
      )
      .run();
  } catch (e) {
    // The fetcher must never throw because of audit logging.
    console.warn("fetch_log insert failed", (e as Error).message);
  }
}

function buildHeaders(): Record<string, string> {
  const ua = pickRandom(USER_AGENTS);
  const platform = pickRandom(PLATFORMS);
  return {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": pickRandom(ACCEPT_LANGS),
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua-Platform": platform,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
}

async function tier0Direct(_env: Env, url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  try {
    const method = opts.method ?? "GET";
    const init: RequestInit = {
      method,
      headers: { ...buildHeaders(), ...(opts.headers ?? {}) },
      redirect: "follow",
      signal: ctl.signal,
    };
    if (method !== "GET" && opts.body !== undefined) init.body = opts.body;
    const res = await fetch(url, init);
    const html = await res.text();
    const blockReason = opts.expectJson
      ? (BLOCK_STATUSES.has(res.status) ? `status_${res.status}` : null)
      : detectBlockReason(res.status, html);
    return {
      ok: res.ok && !blockReason,
      status: res.status,
      url: res.url || url,
      html,
      bytes: html.length,
      durationMs: Date.now() - start,
      tier: 0,
      blockReason,
      fetched_from: "live",
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url,
      html: "",
      bytes: 0,
      durationMs: Date.now() - start,
      tier: 0,
      blockReason: (e as Error).name === "AbortError"
        ? `fetch_timeout:${(e as Error).message}`
        : `fetch_error:${(e as Error).message}`,
      fetched_from: "live",
    };
  } finally {
    clearTimeout(tm);
  }
}

interface BrowserSession {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}
interface BrowserPage {
  setUserAgent(ua: string): Promise<void>;
  setExtraHTTPHeaders(h: Record<string, string>): Promise<void>;
  setViewport(v: { width: number; height: number }): Promise<void>;
  evaluateOnNewDocument?(fn: () => void): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
}

async function tier1Browser(env: Env, url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  if (!env.BROWSER) {
    return blockResult(url, 1, "browser_binding_unavailable");
  }
  try {
    const mod = (await import("@cloudflare/puppeteer").catch(() => null)) as
      | { launch: (b: unknown) => Promise<BrowserSession> }
      | null;
    if (!mod) return blockResult(url, 1, "puppeteer_module_missing");
    const browser = await mod.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      // Task #2: stricter 15s default timeout for ALL page operations
      // (not just goto), so any future waitForSelector / evaluate /
      // content() calls inherit the same ceiling. Swallow if the
      // binding doesn't expose this method (older puppeteer-core).
      try {
        const p = page as unknown as { setDefaultTimeout?: (ms: number) => void };
        p.setDefaultTimeout?.(15_000);
      } catch { /* ignore */ }
      await page.setUserAgent(pickRandom(USER_AGENTS));
      await page.setExtraHTTPHeaders({ "Accept-Language": pickRandom(ACCEPT_LANGS) });
      await page.setViewport({
        width: 1280 + Math.floor(Math.random() * 320),
        height: 720 + Math.floor(Math.random() * 200),
      });
      // Manual stealth — flip the most obvious automation flags. Wrapped in a
      // try/catch since evaluateOnNewDocument isn't on every puppeteer build.
      if (page.evaluateOnNewDocument) {
        // Function body is serialized and executed inside the page context,
        // where `navigator` exists. We use a loose cast so the worker tsc
        // (no DOM lib) doesn't reject the references.
        const stealth = function () {
          const nav = (globalThis as { navigator?: unknown }).navigator as Record<string, unknown> | undefined;
          if (!nav) return;
          Object.defineProperty(nav, "webdriver", { get: () => false });
          Object.defineProperty(nav, "languages", { get: () => ["en-US", "en"] });
          Object.defineProperty(nav, "plugins", { get: () => [1, 2, 3, 4, 5] });
        };
        await page.evaluateOnNewDocument(stealth).catch(() => {});
      }
      const resp = await page.goto(url, {
        waitUntil: "networkidle0",
        // Task #2: 15s browser-nav ceiling per spec policy. Per-job
        // budget + queue sweep are the outer safety net; this keeps
        // any single navigation predictable.
        timeout: opts.timeoutMs ?? 15_000,
      });
      const html = await page.content();
      const status = resp?.status() ?? 200;
      const blockReason = detectBlockReason(status, html);
      return {
        ok: !blockReason,
        status,
        url,
        html,
        bytes: html.length,
        durationMs: Date.now() - start,
        tier: 1,
        blockReason,
        fetched_from: "live",
      };
    } finally {
      await browser.close();
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url,
      html: "",
      bytes: 0,
      durationMs: Date.now() - start,
      tier: 1,
      blockReason: `browser_error:${(e as Error).message}`,
      fetched_from: "live",
    };
  }
}

export async function tier2Proxy(env: Env, url: string, opts: FetchOptions): Promise<FetchResult> {
  // Task #16: failover pool. Try each configured provider in fixed order
  // (generic PROXY_URL first, then Smartproxy → Bright Data → Oxylabs) and
  // succeed as soon as one retrieves the page. Only report a proxy failure
  // once every configured provider has failed; the last failure is returned
  // so the chain escalates to Wayback. See scraper/proxyPool.ts.
  const providers = getProxyProviders(env);
  if (providers.length === 0) return blockResult(url, 2, "proxy_not_configured");

  // Workers fetch() can't dial an arbitrary HTTP CONNECT proxy, so we route
  // through each provider's HTTP forward endpoint: the base URL is the
  // provider URL, the target URL is appended as a query parameter, and the
  // provider auth is sent as basic auth. This pattern matches Smartproxy /
  // Bright Data / Oxylabs "Web Unblocker" style endpoints.
  let last: FetchResult | null = null;
  for (const provider of providers) {
    // Task #70: each provider attempt is a real subrequest. The proxy pool
    // can hold up to 6 providers, so this loop is the dominant subrequest
    // multiplier when a URL is blocked. Pre-empt the next provider once the
    // invocation budget is near-exhausted rather than firing a doomed fetch.
    if (opts.budget?.wouldExceed(1)) {
      last = blockResult(url, 2, "subrequest_budget_exhausted");
      break;
    }
    opts.budget?.spend(1);
    const start = Date.now();
    // Merge caller-supplied headers (e.g. CourtListener Token, Companies
    // House Basic) so authenticated API calls work after tier-0 fails and
    // we escalate to the proxy. Provider auth (basic auth *to the proxy*)
    // is applied after so it always wins on conflict.
    const headers: Record<string, string> = { ...buildHeaders(), ...(opts.headers ?? {}) };
    if (provider.auth) {
      headers["Authorization"] = `Basic ${btoa(provider.auth)}`;
    }
    const ctl = new AbortController();
    // Task #2: 20s fetch ceiling per spec policy (per-provider attempt).
    const tm = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const proxied = `${provider.url}${provider.url.includes("?") ? "&" : "?"}url=${encodeURIComponent(url)}`;
      const res = await fetch(proxied, { method: "GET", headers, redirect: "follow", signal: ctl.signal });
      const html = await res.text();
      const blockReason = opts.expectJson
        ? (BLOCK_STATUSES.has(res.status) ? `status_${res.status}` : null)
        : detectBlockReason(res.status, html);
      const result: FetchResult = {
        ok: res.ok && !blockReason,
        status: res.status,
        url,
        html,
        bytes: html.length,
        durationMs: Date.now() - start,
        tier: 2,
        blockReason,
        fetched_from: "live",
      };
      logProxyAttempt(provider.name, result);
      if (result.ok) return result;
      last = result;
    } catch (e) {
      const result: FetchResult = {
        ok: false,
        status: 0,
        url,
        html: "",
        bytes: 0,
        durationMs: Date.now() - start,
        tier: 2,
        blockReason: (e as Error).name === "AbortError"
          ? `fetch_timeout:proxy:${(e as Error).message}`
          : `proxy_error:${(e as Error).message}`,
        fetched_from: "live",
      };
      logProxyAttempt(provider.name, result);
      last = result;
      // Task #70: the subrequest cap poisons the whole invocation — every
      // later subrequest (the next provider, Wayback) is guaranteed to fail
      // too. Stop the failover loop immediately and surface the limit so the
      // chain (shouldEscalate / fetchPage) skips Wayback and the classifier
      // marks the job retryable instead of permanently dropping it.
      if (isSubrequestLimit(result.blockReason)) return result;
    } finally {
      clearTimeout(tm);
    }
    // On block/error/timeout fall through to the next configured provider.
  }
  // Every configured provider failed → return the last failure so the
  // escalation chain (shouldEscalate) takes the fetch to Wayback.
  return last ?? blockResult(url, 2, "proxy_not_configured");
}

// Per-provider attempt log so operators can see which provider served or
// failed a request. The aggregate fetch_log row is still written by the
// caller (fetchPage → logAttempt); this is the provider-level breakdown.
function logProxyAttempt(provider: string, result: FetchResult): void {
  console.log(
    JSON.stringify({
      event: "proxy.attempt",
      tier: 2,
      provider,
      ok: result.ok,
      status: result.status,
      blockReason: result.blockReason,
      durationMs: result.durationMs,
    }),
  );
}

// Task #5: tier 3 (paid Scraping API) was removed. The fetcher now
// escalates Direct → Browser → Proxy → Wayback.

function blockResult(url: string, tier: FetchTier, reason: string): FetchResult {
  return {
    ok: false,
    status: 0,
    url,
    html: "",
    bytes: 0,
    durationMs: 0,
    tier,
    blockReason: reason,
    fetched_from: "live",
  };
}

// Task #70: detect Cloudflare's per-invocation subrequest ceiling, however it
// arrived — the platform string ("too many subrequests"), or our own
// pre-emptive refusal (`subrequest_budget_exhausted`) once the shared budget is
// near-exhausted. Both mean: do not fire another subrequest this invocation.
function isSubrequestLimit(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return r.includes("too many subrequests") || r.includes("subrequest_budget");
}

function shouldEscalate(reason: string | null): boolean {
  if (!reason) return false;
  // Task #70: a subrequest-limit failure must never escalate — the next tier is
  // one more doomed subrequest in an already-poisoned invocation.
  if (isSubrequestLimit(reason)) return false;
  // "Tier unavailable / not configured" reasons must always escalate so that a
  // missing browser binding or unset proxy doesn't short-circuit the chain.
  if (
    reason === "browser_binding_unavailable" ||
    reason === "puppeteer_module_missing" ||
    reason === "proxy_not_configured"
  ) {
    return true;
  }
  return (
    reason === "captcha" ||
    reason === "too_small" ||
    reason === "low_visible_text" ||
    reason === "status_403" ||
    reason === "status_429" ||
    reason === "status_503" ||
    reason === "status_520" ||
    reason === "status_521" ||
    reason === "status_522" ||
    reason === "status_524" ||
    reason.startsWith("fetch_error") ||
    reason.startsWith("fetch_timeout") ||
    reason.startsWith("proxy_error") ||
    reason.startsWith("browser_error")
  );
}

/**
 * Fetch a page with tiered escalation. Direct → Browser → Proxy, then
 * Wayback as a final fallback. Each attempt is logged to `fetch_log`.
 *
 * Policy:
 *   - robots.txt disallow ⇒ refuse (returns blockReason='robots_disallow').
 *   - ToS-flagged hosts ⇒ refuse (returns blockReason='tos_blocked:...').
 *   - Per-host rate limit honors the larger of `minIntervalMs` and crawl-delay.
 */
export async function fetchPage(env: Env, url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  let host = "unknown";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return blockResult(url, 0, "invalid_url");
  }

  if (!opts.skipPolicy) {
    const tos = tosBlockedReason(host);
    if (tos) {
      const r = blockResult(url, 0, tos);
      await logAttempt(env, opts.jobId, host, url, r);
      return r;
    }
    // Task #2: per-host circuit breaker. If the host has been flapping
    // (5 failures in 10 min), short-circuit for 1h with `circuit_open`.
    // Skipped when `skipPolicy` is set so internal trusted calls bypass.
    const breaker = await isCircuitOpen(env, host);
    if (breaker) {
      const r = blockResult(url, 0, breaker);
      await logAttempt(env, opts.jobId, host, url, r);
      return r;
    }
    const robots = await checkRobots(env, url);
    if (!robots.allowed) {
      const r = blockResult(url, 0, robots.reason ?? "robots_disallow");
      await logAttempt(env, opts.jobId, host, url, r);
      return r;
    }
    const min = Math.max(opts.minIntervalMs ?? 4000, robots.crawlDelayMs);
    await waitForRateLimit(env, host, min);
  } else {
    await waitForRateLimit(env, host, opts.minIntervalMs ?? 4000);
  }

  // Non-GET requests (PACER auth, PCL search, …) can't safely escalate
  // to the browser-render or HTTP-forward proxy tiers — neither replays
  // POST bodies and PACER ToS forbids 3p proxying. Use tier-0 only.
  // Likewise, GETs that carry an Authorization header (CourtListener
  // Token, Companies House Basic) skip tier-2: the HTTP-forward proxy
  // overwrites Authorization with PROXY_AUTH, so the upstream API
  // would receive proxy creds instead of the caller's token and
  // 401. Tier-1 (browser) is also a poor fit for token-auth REST APIs
  // and is therefore skipped — these calls are tier-0 only.
  const isNonGet = opts.method && opts.method !== "GET";
  const hasAuth = !!(opts.headers && Object.keys(opts.headers).some((k) => k.toLowerCase() === "authorization"));
  const tiers: Array<(env: Env, url: string, opts: FetchOptions) => Promise<FetchResult>> = isNonGet || hasAuth
    ? [tier0Direct]
    : opts.forceBrowser
    ? [tier1Browser, tier2Proxy]
    : [tier0Direct, tier1Browser, tier2Proxy];

  let last: FetchResult | null = null;
  for (const fn of tiers) {
    // Task #70: pre-empt a tier attempt that would cross the shared
    // invocation budget — never fire the subrequest that would trip
    // Cloudflare's ceiling. tier2Proxy additionally charges each of its
    // providers, so a proxy escalation is counted conservatively.
    if (opts.budget?.wouldExceed(1)) {
      last = blockResult(url, last?.tier ?? 0, "subrequest_budget_exhausted");
      break;
    }
    opts.budget?.spend(1);
    const r = await fn(env, url, opts);
    await logAttempt(env, opts.jobId, host, url, r);
    if (r.ok) {
      // Success resets the breaker counter for this host.
      if (!opts.skipPolicy) await recordFetchOutcome(env, host, true);
      // Task #2: cache the HTML body for ops-console replay (no-commit
      // re-extraction). Best-effort, capped at 512KB to keep KV usage
      // bounded. TTL 7d; replay reads from this same key and fails
      // with no_cached_html if the snapshot has expired.
      await cacheHtmlForReplay(env, url, r.html).catch(() => undefined);
      return r;
    }
    last = r;
    if (!shouldEscalate(r.blockReason)) break;
  }
  // All tiers failed → count one failure against the host. The breaker
  // may trip if this is the 5th miss inside the 10-min window.
  if (!opts.skipPolicy) await recordFetchOutcome(env, host, false);

  // Live-only callers (e.g. team-path probes) must not be satisfied by
  // archived/cached snapshots — return the last live tier result as-is.
  if (opts.liveOnly) {
    return last ?? blockResult(url, 0, "no_tiers_available");
  }

  // Task #70: when the live tiers stopped because of the subrequest ceiling,
  // do NOT escalate to Wayback — that is one more doomed subrequest in an
  // already-poisoned invocation. Surface the limit so the classifier marks
  // the job transient/retryable.
  if (last && isSubrequestLimit(last.blockReason)) {
    return last;
  }

  // Task #5: Brave Search cache fallback (tier 5) was removed.

  // Task #70: the Wayback fetch is itself a subrequest — pre-empt it when the
  // budget is exhausted rather than firing a doomed final fetch.
  if (opts.budget?.wouldExceed(1)) {
    return last ?? blockResult(url, 4, "subrequest_budget_exhausted");
  }
  opts.budget?.spend(1);

  // Final fallback: Wayback Machine. Logged whether or not a snapshot exists
  // so /api/scrapers/health reflects the true attempt count.
  const wbStart = Date.now();
  const wb = await fetchWaybackHtml(url).catch(() => null);
  if (wb) {
    const wbResult: FetchResult = {
      ok: true,
      status: 200,
      url: wb.url,
      html: wb.html,
      bytes: wb.html.length,
      durationMs: Date.now() - wbStart,
      tier: 4,
      blockReason: null,
      fetched_from: "wayback",
    };
    await logAttempt(env, opts.jobId, host, url, wbResult);
    await cacheHtmlForReplay(env, url, wbResult.html).catch(() => undefined);
    return wbResult;
  }
  await logAttempt(env, opts.jobId, host, url, {
    tier: 4,
    status: 0,
    bytes: 0,
    blockReason: "wayback_not_found",
    durationMs: Date.now() - wbStart,
  });

  return last ?? blockResult(url, 0, "no_tiers_available");
}

/**
 * Fetch a URL as raw bytes (no policy checks beyond ToS, no tier escalation).
 * Used by the PDF code path which needs the binary body. Robots is still
 * honored. Logged as tier 0 so health roll-ups stay accurate.
 */
export async function fetchBytes(
  env: Env,
  url: string,
  opts: FetchOptions = {},
): Promise<{ ok: boolean; bytes: ArrayBuffer; status: number; contentType: string; blockReason: string | null; durationMs: number }> {
  const start = Date.now();
  let host = "unknown";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, bytes: new ArrayBuffer(0), status: 0, contentType: "", blockReason: "invalid_url", durationMs: 0 };
  }
  if (!opts.skipPolicy) {
    const tos = tosBlockedReason(host);
    if (tos) {
      await logAttempt(env, opts.jobId, host, url, { tier: 0, status: 0, bytes: 0, blockReason: tos, durationMs: 0 });
      return { ok: false, bytes: new ArrayBuffer(0), status: 0, contentType: "", blockReason: tos, durationMs: 0 };
    }
    const robots = await checkRobots(env, url);
    if (!robots.allowed) {
      await logAttempt(env, opts.jobId, host, url, { tier: 0, status: 0, bytes: 0, blockReason: robots.reason ?? "robots_disallow", durationMs: 0 });
      return { ok: false, bytes: new ArrayBuffer(0), status: 0, contentType: "", blockReason: robots.reason ?? "robots_disallow", durationMs: 0 };
    }
    await waitForRateLimit(env, host, Math.max(opts.minIntervalMs ?? 4000, robots.crawlDelayMs));
  }
  // Task #70: the binary fetch is a subrequest — pre-empt it (no network,
  // no logAttempt) when it would cross the shared invocation budget, and
  // surface `subrequest_budget_exhausted` so the job is retried.
  if (opts.budget?.wouldExceed(1)) {
    return { ok: false, bytes: new ArrayBuffer(0), status: 0, contentType: "", blockReason: "subrequest_budget_exhausted", durationMs: 0 };
  }
  opts.budget?.spend(1);
  // Task #2: hard timeout on the binary fetch path. Without this, a
  // hung PDF download could stall the queue invocation indefinitely.
  // 20s ceiling per spec policy.
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { ...buildHeaders(), Accept: "application/pdf,*/*" },
      redirect: "follow",
      signal: ctl.signal,
    });
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("Content-Type") ?? "";
    const blockReason = res.ok ? null : `status_${res.status}`;
    const durationMs = Date.now() - start;
    clearTimeout(tm);
    await logAttempt(env, opts.jobId, host, url, { tier: 0, status: res.status, bytes: buf.byteLength, blockReason, durationMs });
    return { ok: res.ok, bytes: buf, status: res.status, contentType: ct, blockReason, durationMs };
  } catch (e) {
    clearTimeout(tm);
    const durationMs = Date.now() - start;
    const aborted = (e as Error).name === "AbortError";
    const reason = aborted ? `fetch_timeout:${opts.timeoutMs ?? 20_000}ms` : `fetch_error:${(e as Error).message}`;
    await logAttempt(env, opts.jobId, host, url, { tier: 0, status: 0, bytes: 0, blockReason: reason, durationMs });
    return { ok: false, bytes: new ArrayBuffer(0), status: 0, contentType: "", blockReason: reason, durationMs };
  }
}
