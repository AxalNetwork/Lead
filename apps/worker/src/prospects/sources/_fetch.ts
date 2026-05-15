// Task #45 follow-up: policy-aware fetch wrapper for source modules.
//
// Centralizes:
//   * robots.txt enforcement via existing scraper/robots.ts
//   * ToS allowlist via scraper/tos.ts
//   * RL_HOST rate limiter (with KV leaky-bucket fallback)
//   * UA + Accept-Language rotation
//
// Source modules MUST use this instead of the global fetch() so every
// outbound crawler request is auditable + compliant. Returns null when
// blocked or rate-limited.

import type { Env } from "../../types";
import { checkRobots } from "../../scraper/robots";
import { tosBlockedReason } from "../../scraper/tos";

const UAS = [
  "Mozilla/5.0 (compatible; AIDataSignalBot/1.0; +https://aidatasignal.com/bot)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
];

export interface CompliantFetchResult {
  ok: boolean;
  status: number;
  body: string;
  blocked?: string;
}

/**
 * Fetch a URL while enforcing robots.txt + ToS + per-host rate limit.
 * Returns null when the request was disallowed; caller should skip.
 */
export async function compliantFetch(
  env: Env,
  url: string,
  source: string,
  init?: { accept?: string; method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
): Promise<CompliantFetchResult | null> {
  let host = "";
  try { host = new URL(url).hostname; } catch { return { ok: false, status: 0, body: "", blocked: "bad_url" }; }

  // ToS allowlist — same gate the deterministic crawler uses.
  const tos = tosBlockedReason(url);
  if (tos) {
    console.warn("compliantFetch tos_blocked", source, host, tos);
    return null;
  }

  // robots.txt — RFC 9309 wildcard policy.
  const robots = await checkRobots(env, url).catch(() => ({ allowed: true, reason: null as string | null }));
  if (!robots.allowed) {
    console.warn("compliantFetch robots_disallow", source, url);
    return null;
  }
  const crawlDelaySeconds = (robots as { crawlDelaySeconds?: number | null }).crawlDelaySeconds ?? null;

  // Per-host rate limit. Prefer the binding; fall back to KV throttle.
  if (env.RL_HOST) {
    try {
      const r = await env.RL_HOST.limit({ key: `crawler:${host}` });
      if (!r.success) return { ok: false, status: 429, body: "", blocked: "rate_limited" };
    } catch { /* fall through */ }
  } else {
    const key = `rl:host:${host}`;
    const last = Number((await env.SCRAPE_CACHE.get(key)) ?? "0");
    const minGapMs = (crawlDelaySeconds ?? 1) * 1000;
    if (Date.now() - last < minGapMs) return { ok: false, status: 429, body: "", blocked: "rate_limited" };
    await env.SCRAPE_CACHE.put(key, String(Date.now()), { expirationTtl: 600 });
  }

  const headers: Record<string, string> = {
    "User-Agent": UAS[Math.floor(Math.random() * UAS.length)],
    "Accept-Language": "en-US,en;q=0.9",
    Accept: init?.accept ?? "application/json,text/html,application/xml;q=0.9",
    ...(init?.headers ?? {}),
  };

  try {
    const res = await fetch(url, { method: init?.method ?? "GET", headers, body: init?.body });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    console.warn("compliantFetch error", source, host, (e as Error).message);
    return { ok: false, status: 0, body: "", blocked: "network_error" };
  }
}
