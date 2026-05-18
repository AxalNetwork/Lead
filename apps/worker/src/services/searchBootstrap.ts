// Task #3: Search-engine bootstrap.
//
// Given `{ name, profile_type_id }`, returns candidate URLs (official site,
// LinkedIn, Crunchbase, Wikipedia) discovered via free-tier web search.
//
// Provider order:
//   1. Brave Search free tier (if BRAVE_API_KEY is set in env).
//   2. DuckDuckGo HTML (scraped, no auth).
//   3. Mojeek HTML (scraped, no auth).
//
// Per-provider quotas tracked in SCRAPE_CACHE KV. Back off on HTTP 429.
// No commercial APIs are ever called.

import type { Env } from "../types";

export interface BootstrapCandidate {
  url: string;
  host: string;
  title: string;
  confidence: number;                              // 0..1
  source_provider: "brave" | "duckduckgo" | "mojeek";
  kind: "official" | "linkedin" | "crunchbase" | "wikipedia" | "other";
}

export interface BootstrapInput {
  name: string;
  profile_type_id?: string | null;
  limit?: number;                                   // default 8
}

const BRAVE_DAILY_KEY = "search:brave:daily";
const BRAVE_DAILY_CAP = 1800;                       // free tier ~2000/day, keep margin
const DDG_HOURLY_KEY = "search:ddg:hourly";
const DDG_HOURLY_CAP = 60;
const MOJEEK_HOURLY_KEY = "search:mojeek:hourly";
const MOJEEK_HOURLY_CAP = 60;

const UA = "Mozilla/5.0 (compatible; AIDataSignalBot/0.1; +https://aidatasignal.com/bot)";

function classifyHit(_url: string, host: string, title: string): BootstrapCandidate["kind"] {
  const h = host.toLowerCase();
  if (h === "linkedin.com" || h.endsWith(".linkedin.com")) return "linkedin";
  if (h === "crunchbase.com" || h.endsWith(".crunchbase.com")) return "crunchbase";
  if (h === "wikipedia.org" || h.endsWith(".wikipedia.org")) return "wikipedia";
  // Heuristic: official site if the host appears in the title.
  const t = title.toLowerCase();
  const apex = h.split(".").slice(-2, -1)[0] ?? "";
  if (apex && t.includes(apex)) return "official";
  return "other";
}

function confidenceFor(kind: BootstrapCandidate["kind"], position: number): number {
  const base: Record<BootstrapCandidate["kind"], number> = {
    official: 0.9, linkedin: 0.85, crunchbase: 0.8, wikipedia: 0.75, other: 0.4,
  };
  return Math.max(0.05, Math.round((base[kind] - position * 0.04) * 100) / 100);
}

async function incrementQuota(env: Env, key: string, cap: number, ttlSec: number): Promise<boolean> {
  if (!env.SCRAPE_CACHE) return true;
  try {
    const raw = await env.SCRAPE_CACHE.get(key);
    const n = raw ? Number(raw) || 0 : 0;
    if (n >= cap) return false;
    await env.SCRAPE_CACHE.put(key, String(n + 1), { expirationTtl: ttlSec });
    return true;
  } catch { return true; /* fail open */ }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

async function searchBrave(env: Env, q: string, limit: number): Promise<BootstrapCandidate[]> {
  const key = env.BRAVE_API_KEY;
  if (!key) return [];
  if (!(await incrementQuota(env, BRAVE_DAILY_KEY, BRAVE_DAILY_CAP, 86400))) return [];
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`, {
      headers: { "X-Subscription-Token": key, "Accept": "application/json", "User-Agent": UA },
    });
    if (res.status === 429) return [];
    if (!res.ok) return [];
    const data = (await res.json()) as { web?: { results?: Array<{ url: string; title: string }> } };
    const hits = data.web?.results ?? [];
    return hits.slice(0, limit).map((h, i) => {
      const host = hostOf(h.url);
      const kind = classifyHit(h.url, host, h.title ?? "");
      return { url: h.url, host, title: h.title ?? "", confidence: confidenceFor(kind, i), source_provider: "brave", kind };
    });
  } catch { return []; }
}

async function searchDuckDuckGo(env: Env, q: string, limit: number): Promise<BootstrapCandidate[]> {
  if (!(await incrementQuota(env, DDG_HOURLY_KEY, DDG_HOURLY_CAP, 3600))) return [];
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
    });
    if (res.status === 429) return [];
    if (!res.ok) return [];
    const html = await res.text();
    const out: BootstrapCandidate[] = [];
    // DDG HTML results are <a class="result__a" href="...">title</a>
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(html)) && out.length < limit) {
      let url = m[1];
      // DDG wraps real URLs in /l/?uddg=...
      const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        try { url = decodeURIComponent(uddgMatch[1]); } catch { /* keep raw */ }
      }
      const title = m[2].replace(/<[^>]+>/g, "").trim();
      const host = hostOf(url);
      if (!host) continue;
      const kind = classifyHit(url, host, title);
      out.push({ url, host, title, confidence: confidenceFor(kind, i), source_provider: "duckduckgo", kind });
      i++;
    }
    return out;
  } catch { return []; }
}

async function searchMojeek(env: Env, q: string, limit: number): Promise<BootstrapCandidate[]> {
  if (!(await incrementQuota(env, MOJEEK_HOURLY_KEY, MOJEEK_HOURLY_CAP, 3600))) return [];
  try {
    const res = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
    });
    if (res.status === 429) return [];
    if (!res.ok) return [];
    const html = await res.text();
    const out: BootstrapCandidate[] = [];
    // Mojeek result anchors carry class="ob".
    const re = /<a[^>]*class="ob"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(html)) && out.length < limit) {
      const url = m[1];
      const title = m[2].replace(/<[^>]+>/g, "").trim();
      const host = hostOf(url);
      if (!host) continue;
      const kind = classifyHit(url, host, title);
      out.push({ url, host, title, confidence: confidenceFor(kind, i), source_provider: "mojeek", kind });
      i++;
    }
    return out;
  } catch { return []; }
}

export async function bootstrapEntity(env: Env, input: BootstrapInput): Promise<BootstrapCandidate[]> {
  const name = (input.name ?? "").trim();
  if (!name) return [];
  const limit = Math.max(1, Math.min(20, input.limit ?? 8));
  const typeHint = input.profile_type_id ? ` ${input.profile_type_id.replace(/_/g, " ")}` : "";
  const q = `${name}${typeHint}`;

  let hits = await searchBrave(env, q, limit);
  if (hits.length < 3) {
    const ddg = await searchDuckDuckGo(env, q, limit);
    // Dedupe by URL.
    const seen = new Set(hits.map((h) => h.url));
    for (const h of ddg) if (!seen.has(h.url)) { hits.push(h); seen.add(h.url); }
  }
  if (hits.length < 3) {
    const mj = await searchMojeek(env, q, limit);
    const seen = new Set(hits.map((h) => h.url));
    for (const h of mj) if (!seen.has(h.url)) { hits.push(h); seen.add(h.url); }
  }

  // Order: official > linkedin > crunchbase > wikipedia > other.
  const rank: Record<BootstrapCandidate["kind"], number> = { official: 0, linkedin: 1, crunchbase: 2, wikipedia: 3, other: 4 };
  hits.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.confidence - a.confidence));
  return hits.slice(0, limit);
}
