import type { Env } from "../types";

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

const ACCEPT_LANGS = ["en-US,en;q=0.9", "en-GB,en;q=0.9", "en-CA,en;q=0.9"];

const CAPTCHA_RE = /captcha|cf-mitigated|attention required|access denied|are you a robot|recaptcha|hcaptcha|datadome/i;
const BLOCK_STATUSES = new Set([401, 403, 407, 408, 423, 429, 451, 503, 520, 521, 522, 524]);

export interface FetchOptions {
  /** Force browser rendering even if direct fetch would succeed. */
  forceBrowser?: boolean;
  /** Per-host minimum interval in milliseconds (default 4000). */
  minIntervalMs?: number;
  /** Abort signal honored by both tiers. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  html: string;
  bytes: number;
  durationMs: number;
  /** Tier that produced the response. 0=direct, 1=browser. */
  tier: 0 | 1;
  /** If non-null, the response was treated as blocked. */
  blockReason: string | null;
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
  // 1h KV TTL is enough; the value is cheap to recreate.
  await env.SCRAPE_CACHE.put(key, JSON.stringify(next), { expirationTtl: 3600 });
}

function detectBlockReason(status: number, body: string): string | null {
  if (BLOCK_STATUSES.has(status)) return `status_${status}`;
  if (CAPTCHA_RE.test(body)) return "captcha";
  if (body.length < 2048) return "too_small";
  return null;
}

async function fetchDirect(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const ua = pickRandom(USER_AGENTS);
  const lang = pickRandom(ACCEPT_LANGS);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": lang,
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
      },
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
    };
  } finally {
    clearTimeout(tm);
  }
}

/**
 * Browser Rendering fallback. Uses the @cloudflare/puppeteer binding when
 * available, otherwise returns a synthetic block result. Loaded dynamically so
 * the dependency is optional at runtime.
 */
async function fetchWithBrowser(env: Env, url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  if (!env.BROWSER) {
    return {
      ok: false,
      status: 0,
      url,
      html: "",
      bytes: 0,
      durationMs: 0,
      tier: 1,
      blockReason: "browser_binding_unavailable",
    };
  }
  try {
    // Dynamic import keeps the dependency optional; if not installed at runtime
    // we still return a controlled error rather than crashing the worker.
    const mod = (await import("@cloudflare/puppeteer").catch(() => null)) as
      | { launch: (b: unknown) => Promise<BrowserSession> }
      | null;
    if (!mod) {
      return {
        ok: false,
        status: 0,
        url,
        html: "",
        bytes: 0,
        durationMs: 0,
        tier: 1,
        blockReason: "puppeteer_module_missing",
      };
    }
    const browser = await mod.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setUserAgent(pickRandom(USER_AGENTS));
      await page.setExtraHTTPHeaders({ "Accept-Language": pickRandom(ACCEPT_LANGS) });
      await page.setViewport({
        width: 1280 + Math.floor(Math.random() * 200),
        height: 720 + Math.floor(Math.random() * 200),
      });
      const resp = await page.goto(url, { waitUntil: "networkidle0", timeout: opts.timeoutMs ?? 30_000 });
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
    };
  }
}

/**
 * Fetch a page using direct fetch first, falling back to Browser Rendering
 * when direct fetch is blocked. Honors a per-host KV-backed rate limit.
 */
export async function fetchPage(env: Env, url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "unknown";
    }
  })();

  await waitForRateLimit(env, host, opts.minIntervalMs ?? 4000);

  if (opts.forceBrowser) {
    return fetchWithBrowser(env, url, opts);
  }

  const direct = await fetchDirect(url, opts);
  if (direct.ok) return direct;

  // Escalate to browser rendering only on signals matching the spec.
  const shouldEscalate =
    direct.blockReason === "captcha" ||
    direct.blockReason === "too_small" ||
    direct.blockReason === "status_403" ||
    direct.blockReason === "status_429" ||
    direct.blockReason === "status_503";

  if (!shouldEscalate) return direct;

  const browser = await fetchWithBrowser(env, url, opts);
  if (browser.ok) return browser;
  return browser.bytes > 0 ? browser : direct;
}

// Minimal puppeteer surface — kept loose because @cloudflare/puppeteer types
// may not be resolvable in every environment.
interface BrowserSession {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}
interface BrowserPage {
  setUserAgent(ua: string): Promise<void>;
  setExtraHTTPHeaders(h: Record<string, string>): Promise<void>;
  setViewport(v: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
}
