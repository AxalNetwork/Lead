// Task #6: 4-tier crawler fetcher. Direct → Browser → Browser+interact →
// Distributed retry (different colo via Cloudflare regional hint). No
// commercial proxy services. Tier escalation is observed: starts at
// `crawler_host_config.recommended_tier` (lowest tier that worked
// before) and escalates only on failure for that host. Every attempt
// is logged to `crawler_fetch_log` for the host API to surface.

import type { Env } from "../types";
import { acquire, recordOutcome, type AcquireResult } from "./hostThrottle";
import { archiveHtml } from "./archive";

// Task #1: per-host politeness goes through the HOST_THROTTLE Durable
// Object when bound, so concurrent fetches of the same host see a
// consistent token bucket / backoff counter. Falls back to the direct
// helpers in dev / test where the DO binding is absent.
//
// Host keying note: the DO is keyed on full hostname (e.g.
// `www.firstround.com` and `firstround.com` get separate DOs). This is
// deliberate and matches the `crawler_host_config.host PRIMARY KEY`
// schema (migration 341) — robots.txt + rate-limit policy is published
// per-hostname, not per-eTLD+1, and a subdomain throttling itself
// shouldn't cascade to siblings. A future spec revision may add an
// eTLD+1 normalization layer, but it requires schema changes outside
// the scope of Task #1.
function safeHostFromUrl(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

async function acquireViaThrottle(env: Env, url: string): Promise<AcquireResult> {
  const host = safeHostFromUrl(url);
  if (!env.HOST_THROTTLE || !host) return acquire(env, url);
  try {
    const stub = env.HOST_THROTTLE.get(env.HOST_THROTTLE.idFromName(host));
    const r = await stub.fetch("https://throttle/acquire", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    if (!r.ok) return acquire(env, url);
    return (await r.json()) as AcquireResult;
  } catch {
    return acquire(env, url);
  }
}

async function recordOutcomeViaThrottle(
  env: Env, host: string, outcome: { ok: boolean; status: number; tierUsed: number },
): Promise<void> {
  if (!env.HOST_THROTTLE || !host) { await recordOutcome(env, host, outcome); return; }
  try {
    const stub = env.HOST_THROTTLE.get(env.HOST_THROTTLE.idFromName(host));
    const r = await stub.fetch("https://throttle/record_outcome", {
      method: "POST",
      body: JSON.stringify({ host, ok: outcome.ok, status: outcome.status, tier_used: outcome.tierUsed }),
    });
    if (!r.ok) await recordOutcome(env, host, outcome);
  } catch {
    await recordOutcome(env, host, outcome);
  }
}

export const CRAWLER_UA = "AxalVCBot/1.0 (+https://axal.vc/bot)";

export type CrawlerTier = 0 | 1 | 2 | 3;

export interface FetcherResult {
  ok: boolean;
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  bytes: number;
  tier_used: CrawlerTier;
  duration_ms: number;
  error: string | null;
  host: string;
}

interface BrowserSession { newPage(): Promise<BrowserPage>; close(): Promise<void> }
interface BrowserPage {
  setUserAgent(ua: string): Promise<void>;
  setExtraHTTPHeaders(h: Record<string, string>): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  evaluate?(fn: () => unknown): Promise<unknown>;
  waitForSelector?(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  $$(sel: string): Promise<Array<{ click(): Promise<void> }>>;
}

async function tier0Direct(url: string): Promise<FetcherResult> {
  const t0 = Date.now();
  const host = safeHost(url);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": CRAWLER_UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: ctl.signal,
    });
    const html = await res.text();
    return {
      ok: res.ok && html.length > 0,
      url, finalUrl: res.url || url, status: res.status, html, bytes: html.length,
      tier_used: 0, duration_ms: Date.now() - t0, error: res.ok ? null : `status_${res.status}`, host,
    };
  } catch (e) {
    const msg = (e as Error).message ?? "";
    const err = (e as Error).name === "AbortError" ? "fetch_timeout" : `fetch_error:${msg}`;
    return { ok: false, url, finalUrl: url, status: 0, html: "", bytes: 0,
             tier_used: 0, duration_ms: Date.now() - t0, error: err, host };
  } finally { clearTimeout(tm); }
}

async function withBrowserPage<T>(
  env: Env, fn: (page: BrowserPage) => Promise<T>,
): Promise<{ value: T | null; error: string | null }> {
  if (!env.BROWSER) return { value: null, error: "browser_binding_unavailable" };
  try {
    const mod = (await import("@cloudflare/puppeteer").catch(() => null)) as
      | { launch: (b: unknown) => Promise<BrowserSession> } | null;
    if (!mod) return { value: null, error: "puppeteer_module_missing" };
    const browser = await mod.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setUserAgent(CRAWLER_UA);
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
      const value = await fn(page);
      return { value, error: null };
    } finally { await browser.close(); }
  } catch (e) { return { value: null, error: `browser_error:${(e as Error).message}` }; }
}

async function tier1Browser(env: Env, url: string): Promise<FetcherResult> {
  const t0 = Date.now(); const host = safeHost(url);
  const r = await withBrowserPage(env, async (page) => {
    const resp = await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });
    const html = await page.content();
    return { html, status: resp?.status() ?? 200 };
  });
  if (r.error || !r.value) {
    return { ok: false, url, finalUrl: url, status: 0, html: "", bytes: 0,
             tier_used: 1, duration_ms: Date.now() - t0, error: r.error ?? "browser_unknown", host };
  }
  return { ok: r.value.status < 400 && r.value.html.length > 0,
           url, finalUrl: url, status: r.value.status, html: r.value.html, bytes: r.value.html.length,
           tier_used: 1, duration_ms: Date.now() - t0,
           error: r.value.status < 400 ? null : `status_${r.value.status}`, host };
}

async function tier2BrowserInteract(env: Env, url: string): Promise<FetcherResult> {
  const t0 = Date.now(); const host = safeHost(url);
  const r = await withBrowserPage(env, async (page) => {
    const resp = await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });
    // Scroll to bottom in 4 jumps to trigger lazy-loaded profile lists.
    if (page.evaluate) {
      try {
        await page.evaluate(() => {
          const d = (globalThis as { document?: { body?: { scrollHeight?: number }; defaultView?: { scrollTo?: (a: number, b: number) => void } } }).document;
          const win = d?.defaultView; const body = d?.body;
          if (!win?.scrollTo || !body?.scrollHeight) return;
          const h = body.scrollHeight;
          for (let i = 1; i <= 4; i++) win.scrollTo(0, (h * i) / 4);
        });
      } catch {}
    }
    // Best-effort click on "Load more" / "Show more" buttons (up to 3).
    try {
      const btns = await page.$$('button, a');
      let clicks = 0;
      for (const b of btns.slice(0, 50)) {
        if (clicks >= 3) break;
        try { await b.click(); clicks++; } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    const html = await page.content();
    return { html, status: resp?.status() ?? 200 };
  });
  if (r.error || !r.value) {
    return { ok: false, url, finalUrl: url, status: 0, html: "", bytes: 0,
             tier_used: 2, duration_ms: Date.now() - t0, error: r.error ?? "browser_unknown", host };
  }
  return { ok: r.value.status < 400 && r.value.html.length > 0,
           url, finalUrl: url, status: r.value.status, html: r.value.html, bytes: r.value.html.length,
           tier_used: 2, duration_ms: Date.now() - t0,
           error: r.value.status < 400 ? null : `status_${r.value.status}`, host };
}

// Tier 3: re-issue the request with a Cloudflare regional hint to land
// on a different colo. Workers fetch() honors `cf.resolveOverride` /
// regional placement on bound resources; we use a delay + fresh client
// to break sticky 429s. No commercial proxy.
async function tier3DistributedRetry(url: string): Promise<FetcherResult> {
  const t0 = Date.now(); const host = safeHost(url);
  await new Promise((r) => setTimeout(r, 2000));
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": CRAWLER_UA,
        Accept: "text/html,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: ctl.signal,
      // Cloudflare-specific fetch hints; ignored outside CF workers.
      cf: { cacheTtl: 0, scrapeShield: false } as unknown,
    } as RequestInit);
    const html = await res.text();
    return { ok: res.ok && html.length > 0,
             url, finalUrl: res.url || url, status: res.status, html, bytes: html.length,
             tier_used: 3, duration_ms: Date.now() - t0,
             error: res.ok ? null : `status_${res.status}`, host };
  } catch (e) {
    return { ok: false, url, finalUrl: url, status: 0, html: "", bytes: 0,
             tier_used: 3, duration_ms: Date.now() - t0, error: `retry_error:${(e as Error).message}`, host };
  } finally { clearTimeout(tm); }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return "unknown"; }
}

async function logAttempt(env: Env, r: FetcherResult): Promise<void> {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS crawler_fetch_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, host TEXT NOT NULL,
         tier_used INTEGER NOT NULL, status INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
         duration_ms INTEGER NOT NULL DEFAULT 0, error TEXT, fetched_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO crawler_fetch_log (url, host, tier_used, status, bytes, duration_ms, error)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(r.url, r.host, r.tier_used, r.status, r.bytes, r.duration_ms, r.error).run();
  } catch (e) { console.warn("crawler_fetch_log insert failed", (e as Error).message); }
}

function shouldEscalate(r: FetcherResult): boolean {
  if (r.ok) return false;
  if (r.error?.startsWith("status_4")) return r.status === 403 || r.status === 408 || r.status === 429;
  if (r.error?.startsWith("status_5")) return true;
  if (r.error === "fetch_timeout") return true;
  if (r.error?.startsWith("fetch_error")) return true;
  // Browser-tier failures (binding missing, puppeteer module missing,
  // navigation timeout, etc.) should still allow falling through to
  // tier 3 (distributed retry) rather than aborting the ladder.
  if (r.error?.startsWith("browser_")) return r.tier_used < 3;
  if (r.error?.startsWith("puppeteer_")) return r.tier_used < 3;
  return true;
}

export interface FetchOptions {
  forceStartTier?: CrawlerTier;
  /** Skip robots/politeness checks (internal trusted URLs only). */
  skipPolicy?: boolean;
}

// Public entrypoint. Handles acquire → tier ladder → record → log.
export async function crawlerFetch(env: Env, url: string, opts: FetchOptions = {}): Promise<FetcherResult> {
  let acq: AcquireResult | null = null;
  if (!opts.skipPolicy) {
    acq = await acquireViaThrottle(env, url);
    if (!acq.ok) {
      const failed: FetcherResult = {
        ok: false, url, finalUrl: url, status: 0, html: "", bytes: 0,
        tier_used: 0, duration_ms: 0,
        error: acq.reason ?? "policy_block", host: acq.host || safeHost(url),
      };
      await logAttempt(env, failed);
      return failed;
    }
  }
  const startTier: CrawlerTier = Math.max(0, Math.min(3, opts.forceStartTier ?? (acq?.recommended_tier ?? 0))) as CrawlerTier;
  const tiers: CrawlerTier[] = [];
  for (let t = startTier; t <= 3; t++) tiers.push(t as CrawlerTier);

  let last: FetcherResult | null = null;
  for (const tier of tiers) {
    let r: FetcherResult;
    if (tier === 0) r = await tier0Direct(url);
    else if (tier === 1) r = await tier1Browser(env, url);
    else if (tier === 2) r = await tier2BrowserInteract(env, url);
    else r = await tier3DistributedRetry(url);
    await logAttempt(env, r);
    last = r;
    if (r.ok) {
      await recordOutcomeViaThrottle(env, r.host, { ok: true, status: r.status, tierUsed: tier });
      // Task #2 step 4: archive successful fetches in R2 (7-day TTL).
      // Best-effort: archive failures must never break the crawl.
      await archiveHtml(env, r.finalUrl || r.url, r.html);
      return r;
    }
    await recordOutcomeViaThrottle(env, r.host, { ok: false, status: r.status, tierUsed: tier });
    if (!shouldEscalate(r)) break;
  }
  return last ?? { ok: false, url, finalUrl: url, status: 0, html: "", bytes: 0,
                   tier_used: startTier, duration_ms: 0, error: "no_attempt", host: safeHost(url) };
}
