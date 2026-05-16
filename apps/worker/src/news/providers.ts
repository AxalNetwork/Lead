// Task #2: News providers.
//
// Each provider takes (env, query, opts) and returns a list of NewsCandidate
// objects with raw URL + title + headline + byline + published_at + source.
// Providers are SKIPPED (return []) when their credentials are absent —
// callers always check before hitting them.
//
// Providers implemented here:
//   - newsapi.org       (NEWS_API_KEY)             general news, ~100/day cap on free tier
//   - GDELT 2.0 DOC API (keyless)                  global, 65 languages
//   - PRNewswire RSS    (keyless)                  /news-releases/news-releases-list/?keyword=
//   - BusinessWire RSS  (keyless)                  /portal/site/home/news/?ndmHsc=O%2bSearch
//   - SEC EDGAR press   (keyless, requires UA)     /cgi-bin/browse-edgar?action=getcompany
//   - gov.uk / state.gov / EC press (keyless)      common RSS endpoints
//   - congress.gov      (CONGRESS_API_KEY)         federal bill mentions

import type { Env } from "../types";

export interface NewsCandidate {
  url: string;
  title?: string | null;
  headline?: string | null;
  byline?: string | null;
  published_at?: string | null;
  source_name?: string | null;
  language?: string | null;
  snippet?: string | null;
  provider: string;
}

const UA = "AIDataSignal/1.0 (+https://aidatasignal.com; contact@aidatasignal.com)";

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...(init ?? {}),
      headers: { "user-agent": UA, accept: "application/json", ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function fetchText(url: string, init?: RequestInit, timeoutMs = 12000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...(init ?? {}),
      headers: { "user-agent": UA, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html", ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; } finally { clearTimeout(t); }
}

// ---------- newsapi.org ----------
export async function fromNewsApi(env: Env, query: string, opts: { pageSize?: number; language?: string } = {}): Promise<NewsCandidate[]> {
  const key = env.NEWS_API_KEY || env.NEWSAPI_KEY;
  if (!key) return [];
  const pageSize = Math.min(opts.pageSize ?? 100, 100);
  const lang = opts.language ?? "en";
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(`"${query}"`)}&pageSize=${pageSize}&language=${lang}&sortBy=publishedAt`;
  const data = (await fetchJson(url, { headers: { "x-api-key": key } })) as { articles?: Array<{ url: string; title?: string; description?: string; publishedAt?: string; author?: string; source?: { name?: string } }> } | null;
  if (!data?.articles) return [];
  return data.articles.filter((a) => a.url).map((a) => ({
    url: a.url,
    title: a.title ?? null,
    headline: a.title ?? null,
    byline: a.author ?? null,
    published_at: a.publishedAt ?? null,
    source_name: a.source?.name ?? null,
    snippet: a.description ?? null,
    language: lang,
    provider: "newsapi",
  }));
}

// ---------- GDELT 2.0 DOC ----------
function parseGdeltDate(s: string | undefined): string | null {
  if (!s || s.length < 14) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
}

export async function fromGdelt(env: Env, query: string, opts: { maxRecords?: number } = {}): Promise<NewsCandidate[]> {
  void env;
  const max = Math.min(opts.maxRecords ?? 50, 250);
  const q = `"${query.replace(/"/g, " ")}"`;
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&format=json&maxrecords=${max}&sort=DateDesc`;
  const data = (await fetchJson(url)) as { articles?: Array<{ url?: string; url_mobile?: string; title?: string; seendate?: string; domain?: string; language?: string }> } | null;
  if (!data?.articles) return [];
  return data.articles.filter((a) => a.url).map((a) => ({
    url: a.url!,
    title: a.title ?? null,
    headline: a.title ?? null,
    byline: null,
    published_at: parseGdeltDate(a.seendate),
    source_name: a.domain ?? null,
    snippet: a.title ?? null,
    language: (a.language ?? "").toLowerCase().slice(0, 2) || null,
    provider: "gdelt",
  }));
}

// ---------- RSS helpers ----------
// Tiny RSS/Atom parser using regex — Workers don't ship a DOM, and pulling
// fast-xml-parser bloats the bundle. We only need <item>/<entry> children.
function parseRssItems(xml: string, source: string, provider: string): NewsCandidate[] {
  const items: NewsCandidate[] = [];
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  for (const m of xml.matchAll(itemRe)) {
    const block = m[0];
    const linkMatch = block.match(/<link(?:\s[^>]*)?>([^<]+)<\/link>/i) || block.match(/<link\s[^>]*href="([^"]+)"/i);
    const titleMatch = block.match(/<title(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const dateMatch = block.match(/<(pubDate|published|updated|dc:date)(?:\s[^>]*)?>([^<]+)<\/\1>/i);
    const descMatch = block.match(/<(description|summary|content)(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/i);
    const url = (linkMatch?.[1] || "").trim();
    if (!url) continue;
    const title = (titleMatch?.[1] || "").trim();
    const pub = dateMatch ? new Date(dateMatch[2]).toISOString() : null;
    const snippet = descMatch ? descMatch[2].replace(/<[^>]+>/g, " ").trim().slice(0, 500) : null;
    items.push({ url, title, headline: title, byline: null, published_at: pub, source_name: source, snippet, language: "en", provider });
  }
  return items;
}

// ---------- PRNewswire / BusinessWire ----------
export async function fromPRNewswire(_env: Env, query: string): Promise<NewsCandidate[]> {
  // PRNewswire keyword RSS — undocumented but stable. Falls back to []
  // on any error.
  const url = `https://www.prnewswire.com/rss/news-releases-list.rss?keyword=${encodeURIComponent(query)}`;
  const xml = await fetchText(url);
  if (!xml) return [];
  return parseRssItems(xml, "PR Newswire", "prnewswire").slice(0, 50);
}

export async function fromBusinessWire(_env: Env, query: string): Promise<NewsCandidate[]> {
  const url = `https://www.businesswire.com/portal/site/home/news/?ndmHsc=O%2bSearch&searchType=news&searchTerm=${encodeURIComponent(query)}&searchPath=&ndmConfigId=1000007`;
  const html = await fetchText(url);
  if (!html) return [];
  // BW returns HTML; we extract anchor cards. Cheap regex pass.
  const items: NewsCandidate[] = [];
  const re = /<a[^>]+href="(https:\/\/www\.businesswire\.com\/news\/home\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    items.push({ url: m[1], title: m[2].trim(), headline: m[2].trim(), byline: null, published_at: null, source_name: "Business Wire", snippet: null, language: "en", provider: "businesswire" });
    if (items.length >= 50) break;
  }
  return items;
}

// ---------- Regulator RSS feeds ----------
const REGULATOR_FEEDS: Array<{ name: string; url: string; provider: string }> = [
  { name: "SEC",          url: "https://www.sec.gov/news/pressreleases.rss",                                  provider: "sec" },
  { name: "FCA",          url: "https://www.fca.org.uk/news/rss.xml",                                          provider: "fca" },
  { name: "ESMA",         url: "https://www.esma.europa.eu/press-news/esma-news/rss.xml",                     provider: "esma" },
  { name: "FINRA",        url: "https://www.finra.org/rss/newsreleases.xml",                                   provider: "finra" },
  { name: "CFTC",         url: "https://www.cftc.gov/PressRoom/PressReleases/rss",                             provider: "cftc" },
  { name: "DOJ",          url: "https://www.justice.gov/feeds/opa/justice-news.xml",                           provider: "doj" },
  { name: "gov.uk",       url: "https://www.gov.uk/government/announcements.atom",                             provider: "govuk" },
  { name: "State.gov",    url: "https://www.state.gov/feed/",                                                  provider: "state" },
  { name: "European Comm",url: "https://ec.europa.eu/commission/presscorner/api/rss?language=en&service=PRESS_RELEASE", provider: "ec" },
];

// Fetch every regulator feed and keyword-filter against `query`. Best
// effort — failing feeds are skipped silently.
export async function fromRegulators(_env: Env, query: string): Promise<NewsCandidate[]> {
  const q = query.toLowerCase();
  const out: NewsCandidate[] = [];
  await Promise.all(REGULATOR_FEEDS.map(async (f) => {
    const xml = await fetchText(f.url);
    if (!xml) return;
    for (const item of parseRssItems(xml, f.name, f.provider)) {
      const hay = `${item.title ?? ""} ${item.snippet ?? ""}`.toLowerCase();
      if (hay.includes(q)) out.push(item);
    }
  }));
  return out.slice(0, 100);
}

// ---------- congress.gov ----------
export async function fromCongress(env: Env, query: string): Promise<NewsCandidate[]> {
  const key = env.CONGRESS_API_KEY;
  if (!key) return [];
  const url = `https://api.congress.gov/v3/bill?api_key=${key}&query=${encodeURIComponent(query)}&limit=20&format=json`;
  const data = (await fetchJson(url)) as { bills?: Array<{ url?: string; title?: string; updateDate?: string; congress?: number; number?: string; type?: string }> } | null;
  if (!data?.bills) return [];
  return data.bills.filter((b) => b.url || (b.congress && b.number && b.type)).map((b) => {
    const url = b.url ?? `https://www.congress.gov/bill/${b.congress}/${(b.type ?? "").toLowerCase()}/${b.number}`;
    return {
      url,
      title: b.title ?? null,
      headline: b.title ?? null,
      byline: null,
      published_at: b.updateDate ?? null,
      source_name: "congress.gov",
      snippet: b.title ?? null,
      language: "en",
      provider: "congress",
    };
  });
}

// ---------- Wikinews (keyless) ----------
export async function fromWikinews(_env: Env, query: string): Promise<NewsCandidate[]> {
  const url = `https://en.wikinews.org/w/api.php?action=opensearch&format=json&limit=10&search=${encodeURIComponent(query)}`;
  const data = (await fetchJson(url)) as [string, string[], string[], string[]] | null;
  if (!Array.isArray(data) || data.length < 4) return [];
  const [, titles, snippets, urls] = data;
  return urls.map((url, i) => ({
    url,
    title: titles[i] ?? null,
    headline: titles[i] ?? null,
    byline: null,
    published_at: null,
    source_name: "Wikinews",
    snippet: snippets[i] ?? null,
    language: "en",
    provider: "wikinews",
  }));
}

// Aggregate fan-out — calls every enabled provider in parallel and dedupes
// by URL. The caller decides what to do with the candidates (enrich +
// persist via `persistAndEnrich` in refresh.ts).
export async function fanOutAllProviders(env: Env, query: string, opts: { newsapiPageSize?: number } = {}): Promise<NewsCandidate[]> {
  const [api, gdelt, prn, bw, regs, cong, wn] = await Promise.all([
    fromNewsApi(env, query, { pageSize: opts.newsapiPageSize }),
    fromGdelt(env, query),
    fromPRNewswire(env, query),
    fromBusinessWire(env, query),
    fromRegulators(env, query),
    fromCongress(env, query),
    fromWikinews(env, query),
  ]);
  const seen = new Set<string>();
  const out: NewsCandidate[] = [];
  for (const arr of [api, gdelt, prn, bw, regs, cong, wn]) {
    for (const c of arr) {
      const k = c.url.split("#")[0].toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}
