// Public web search facade. Prefers Brave Search API when BRAVE_SEARCH_KEY (or
// BRAVE_API_KEY) is configured; otherwise falls back to a Browser-Rendering
// site:google search. Returns a normalized list of hits.

import type { Env } from "../types";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  source: "brave" | "google_browser";
}

interface BraveJson {
  web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
}

async function searchBrave(env: Env, q: string, limit: number): Promise<SearchHit[] | null> {
  const key = env.BRAVE_SEARCH_KEY ?? env.BRAVE_API_KEY;
  if (!key) return null;
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`;
    const res = await fetch(url, {
      headers: { "X-Subscription-Token": key, Accept: "application/json", "User-Agent": "AIDataSignalBot/1.0" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as BraveJson;
    const out: SearchHit[] = [];
    for (const r of json.web?.results ?? []) {
      if (!r.url) continue;
      out.push({ url: r.url, title: r.title ?? "", snippet: r.description ?? "", source: "brave" });
    }
    return out;
  } catch {
    return null;
  }
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
  // Best-effort extraction of organic hits without an HTML parser dependency.
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
  const brave = await searchBrave(env, q, limit);
  if (brave && brave.length) return brave;
  return await searchGoogleViaBrowser(env, q, limit);
}
