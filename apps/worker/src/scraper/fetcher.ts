import type { Env } from "../types";
import { checkRobots } from "./robots";
import { tosBlockedReason } from "./tos";
import { fetchWaybackHtml } from "./fallbacks/wayback";

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
// by request; proxy/scraping API are rough averages used for the health roll-up.
const TIER_COST_USD = { 0: 0, 1: 0.0009, 2: 0.0015, 3: 0.005, 4: 0 } as const;

export type FetchTier = 0 | 1 | 2 | 3 | 4;

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

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface RateLimitState {
  lastFetchedAt: number;
}

async function waitForRateLimit(env: Env, host: string, minIntervalMs: number): Promise<void> {
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
    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
      redirect: "follow",
      signal: ctl.signal,
    });
    const html = await res.text();
    const blockReason = detectBlockReason(res.status, html);
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
      blockReason: `fetch_error:${(e as Error).message}`,
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
        timeout: opts.timeoutMs ?? 30_000,
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

async function tier2Proxy(env: Env, url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  if (!env.PROXY_URL) return blockResult(url, 2, "proxy_not_configured");
  // Workers fetch() can't dial an arbitrary HTTP CONNECT proxy, so we route
  // through the proxy provider's HTTP forward endpoint: PROXY_URL is the
  // base URL, the target URL is appended as a query parameter, and
  // PROXY_AUTH is sent as basic auth. This pattern matches Smartproxy /
  // Bright Data / Oxylabs "Web Unblocker" style endpoints.
  const headers: Record<string, string> = { ...buildHeaders() };
  if (env.PROXY_AUTH) {
    headers.Authorization = `Basic ${btoa(env.PROXY_AUTH)}`;
  }
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const proxied = `${env.PROXY_URL}${env.PROXY_URL.includes("?") ? "&" : "?"}url=${encodeURIComponent(url)}`;
    const res = await fetch(proxied, { method: "GET", headers, redirect: "follow", signal: ctl.signal });
    const html = await res.text();
    const blockReason = detectBlockReason(res.status, html);
    return {
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
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url,
      html: "",
      bytes: 0,
      durationMs: Date.now() - start,
      tier: 2,
      blockReason: `proxy_error:${(e as Error).message}`,
      fetched_from: "live",
    };
  } finally {
    clearTimeout(tm);
  }
}

async function tier3ScrapingApi(env: Env, url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  if (!env.SCRAPER_API_KEY) return blockResult(url, 3, "scraping_api_not_configured");
  const provider = (env.SCRAPER_API_PROVIDER ?? "scraperapi").toLowerCase();
  let endpoint = "";
  switch (provider) {
    case "scrapingbee":
      endpoint = `https://app.scrapingbee.com/api/v1/?api_key=${env.SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render_js=true`;
      break;
    case "zenrows":
      endpoint = `https://api.zenrows.com/v1/?apikey=${env.SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&js_render=true&premium_proxy=true`;
      break;
    case "scraperapi":
    default:
      endpoint = `https://api.scraperapi.com/?api_key=${env.SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=true`;
      break;
  }
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(endpoint, { method: "GET", signal: ctl.signal });
    const html = await res.text();
    const blockReason = detectBlockReason(res.status, html);
    return {
      ok: res.ok && !blockReason,
      status: res.status,
      url,
      html,
      bytes: html.length,
      durationMs: Date.now() - start,
      tier: 3,
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
      tier: 3,
      blockReason: `scraping_api_error:${(e as Error).message}`,
      fetched_from: "live",
    };
  } finally {
    clearTimeout(tm);
  }
}

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

function shouldEscalate(reason: string | null): boolean {
  if (!reason) return false;
  // "Tier unavailable / not configured" reasons must always escalate so that a
  // missing browser binding or unset proxy doesn't short-circuit the chain.
  if (
    reason === "browser_binding_unavailable" ||
    reason === "puppeteer_module_missing" ||
    reason === "proxy_not_configured" ||
    reason === "scraping_api_not_configured"
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
    reason.startsWith("proxy_error") ||
    reason.startsWith("scraping_api_error") ||
    reason.startsWith("browser_error")
  );
}

/**
 * Fetch a page with tiered escalation. Direct → Browser → Proxy → Scraping API,
 * then Wayback as a final fallback. Each attempt is logged to `fetch_log`.
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

  const tiers: Array<(env: Env, url: string, opts: FetchOptions) => Promise<FetchResult>> = opts.forceBrowser
    ? [tier1Browser, tier2Proxy, tier3ScrapingApi]
    : [tier0Direct, tier1Browser, tier2Proxy, tier3ScrapingApi];

  let last: FetchResult | null = null;
  for (const fn of tiers) {
    const r = await fn(env, url, opts);
    await logAttempt(env, opts.jobId, host, url, r);
    if (r.ok) return r;
    last = r;
    if (!shouldEscalate(r.blockReason)) break;
  }

  // Final fallback: Wayback Machine. Tagged so callers can record provenance.
  const wb = await fetchWaybackHtml(url);
  if (wb) {
    const wbResult: FetchResult = {
      ok: true,
      status: 200,
      url: wb.url,
      html: wb.html,
      bytes: wb.html.length,
      durationMs: 0,
      tier: 4,
      blockReason: null,
      fetched_from: "wayback",
    };
    await logAttempt(env, opts.jobId, host, url, wbResult);
    return wbResult;
  }

  return last ?? blockResult(url, 0, "no_tiers_available");
}
