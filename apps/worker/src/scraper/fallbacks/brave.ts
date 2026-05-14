import type { Env } from "../../types";

/**
 * Brave Search cache fallback. The Brave Web Search API
 * (https://api.search.brave.com/res/v1/web/search) returns search hits with
 * descriptions and (for some results) cached page URLs. We use the operator
 * `url:<target>` to ask Brave for what it has indexed for that exact URL.
 *
 * Requires the optional secret BRAVE_API_KEY. When unset this returns null
 * and the fetch chain proceeds to Wayback.
 */

interface BraveSearchResult {
  url?: string;
  description?: string;
  page_age?: string;
  cached_url?: string;
}

interface BraveResponse {
  web?: { results?: BraveSearchResult[] };
}

export async function fetchBraveCache(env: Env, targetUrl: string): Promise<{ url: string; html: string } | null> {
  if (!env.BRAVE_API_KEY) return null;
  try {
    const q = encodeURIComponent(`url:${targetUrl}`);
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=3`, {
      headers: {
        "X-Subscription-Token": env.BRAVE_API_KEY,
        Accept: "application/json",
        "User-Agent": "AIDataSignalBot/1.0 (+https://aidatasignal.com)",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as BraveResponse;
    const hit = (json.web?.results ?? []).find((r) => r.url === targetUrl) ?? json.web?.results?.[0];
    if (!hit) return null;

    // Prefer a cached page URL when Brave provides one. Otherwise fall back to
    // synthesizing a minimal HTML doc from the result description so callers
    // still have *something* to parse for context (names, emails).
    if (hit.cached_url) {
      const cached = await fetch(hit.cached_url, {
        headers: { "User-Agent": "AIDataSignalBot/1.0 (+https://aidatasignal.com)" },
      });
      if (cached.ok) {
        const html = await cached.text();
        if (html.length >= 1024) return { url: hit.cached_url, html };
      }
    }
    if (hit.description) {
      const html = `<html><body><div data-source="brave-cache">${hit.description}</div></body></html>`;
      return { url: hit.url ?? targetUrl, html };
    }
    return null;
  } catch {
    return null;
  }
}
