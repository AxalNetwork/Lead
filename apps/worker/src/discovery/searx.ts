// Public web search facade. Task #5: the paid Brave Search path was
// removed; we now use Browser-Rendering site:google as the sole engine.
// Returns a normalized list of hits.

import type { Env } from "../types";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  source: "google_browser";
}

async function searchGoogleViaBrowser(env: Env, q: string, limit: number): Promise<SearchHit[]> {
  if (!env.BROWSER) return [];
  try {
    const target = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${limit}&hl=en`;
    const res = await env.BROWSER.fetch(target, { headers: { "User-Agent": "AIDataSignalBot/1.0" } });
    if (!res.ok) return [];
    const html = await res.text();
    return parseGoogleHtml(html, limit);
  } catch {
    return [];
  }
}

function parseGoogleHtml(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /<a[^>]+href="\/url\?q=([^&"]+)[^"]*"[^>]*><h3[^>]*>([^<]+)<\/h3>/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html)) && hits.length < limit) {
    const url = decodeURIComponent(m[1] ?? "");
    if (!url || seen.has(url)) continue;
    if (url.startsWith("https://www.google.")) continue;
    seen.add(url);
    hits.push({ url, title: m[2] ?? "", snippet: "", source: "google_browser" });
  }
  return hits;
}

export async function search(env: Env, q: string, limit = 10): Promise<SearchHit[]> {
  return await searchGoogleViaBrowser(env, q, limit);
}
