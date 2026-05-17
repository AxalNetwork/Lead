// Task #2: discovery methods. Each function returns RawLink[] which the
// orchestrator canonicalizes, predicts yield for, and upserts.
//
// We ship the 8 highest-leverage methods here. The remaining 10 (google
// dorks, common-crawl, pdf annotations, scholar, patent, conference
// programs, foundation filings, social_bio, linktree, registry_links)
// are stubbed in the orchestrator so they can be added incrementally
// without touching the dispatch layer.

import type { Env } from "../types";
import { fetchPage } from "../scraper/fetcher";
import { canonicalizeUrl, sameSite, isObviousReject } from "./canonical";

export interface RawLink {
  url: string;
  link_text?: string | null;
  link_context?: string | null;
  likely_kind?: string | null;
  method: string;
}

const UA = "AIDataSignal/1.0 (+https://aidatasignal.com)";

async function fetchText(env: Env, url: string, _timeoutMs = 15_000): Promise<string | null> {
  // Route through the shared `fetchPage` so discovery-method network calls
  // inherit the policy stack (robots/ToS gates, host rate-limit, circuit
  // breaker, multi-tier fallback). Previously this used raw `fetch` which
  // bypassed all of that and risked compliance drift between discovery
  // and the main scrape pipeline.
  try {
    const r = await fetchPage(env, url).catch(() => null);
    if (!r || !r.ok || !r.html) return null;
    return r.html;
  } catch { return null; }
}
// Keep UA exported-ish so future direct fetches (if any) reuse it.
void UA;

// ----------------------------------------------------------------------------
// 1. outbound — every <a href> from a fetched HTML page.
// ----------------------------------------------------------------------------

const NAV_TEXT_RE = /^(home|about|contact|login|signup|sign in|sign up|privacy|terms|cookies?|menu|search|share|tweet|follow|subscribe)$/i;

export async function methodOutbound(env: Env, seedUrl: string, html?: string): Promise<RawLink[]> {
  let body = html;
  if (!body) {
    const f = await fetchPage(env, seedUrl).catch(() => null);
    body = f?.html ?? undefined;
  }
  if (!body) return [];
  const out: RawLink[] = [];
  const seenLocal = new Set<string>();
  const seedCanon = canonicalizeUrl(seedUrl);
  // Crude but fast: regex over <a ... href="..." ...>text</a>. We deliberately
  // do not pull in a full HTML parser; this runs on hundreds of pages.
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const rawHref = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#")) continue;
    let abs: string;
    try { abs = new URL(rawHref, seedUrl).toString(); } catch { continue; }
    const c = canonicalizeUrl(abs);
    if (!c || isObviousReject(c)) continue;
    if (seenLocal.has(c.canonical)) continue;
    seenLocal.add(c.canonical);
    const text = m[4].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
    // Drop common nav cruft same-site.
    if (seedCanon && sameSite(c.host, seedCanon.host) && NAV_TEXT_RE.test(text)) continue;
    out.push({ url: c.url, link_text: text || null, method: "outbound", likely_kind: guessKind(c.canonical, text) });
  }
  return out;
}

function guessKind(canon: string, text: string): string | null {
  const lower = canon.toLowerCase();
  if (/\/(team|people|about\/team|leadership|partners|staff|members)(\/|$)/.test(lower)) return "team_page";
  if (/\/(blog|news|press|insights|writings|essays)(\/|$)/.test(lower)) return "writing";
  if (/\/portfolio|\/companies(\/|$)/.test(lower)) return "portfolio";
  if (/\.pdf(\?|$)/.test(lower)) return "pdf";
  if (/\b(bio|cv|resume)\b/i.test(text)) return "bio";
  return null;
}

// ----------------------------------------------------------------------------
// 2. sitemap — /sitemap.xml, /sitemap_index.xml, /wp-sitemap.xml, robots.txt.
// ----------------------------------------------------------------------------

export async function methodSitemap(env: Env, seedUrl: string): Promise<RawLink[]> {
  const u = canonicalizeUrl(seedUrl);
  if (!u) return [];
  const base = `${u.scheme}://${u.host}`;
  const candidates = [
    `${base}/sitemap.xml`, `${base}/sitemap_index.xml`, `${base}/wp-sitemap.xml`,
    `${base}/sitemap-index.xml`, `${base}/sitemap1.xml`,
  ];
  // robots.txt may declare additional sitemaps.
  const robots = await fetchText(env, `${base}/robots.txt`, 8000);
  if (robots) {
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.push(m[1].trim());
  }

  const seen = new Set<string>();
  const out: RawLink[] = [];
  const visit = async (url: string, depth: number) => {
    if (depth > 2 || seen.has(url) || seen.size > 8) return;
    seen.add(url);
    const txt = await fetchText(env, url, 15_000);
    if (!txt) return;
    // <loc>…</loc> entries — covers sitemap-index AND urlset.
    for (const m of txt.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const child = m[1];
      if (/sitemap.*\.xml$/i.test(child)) await visit(child, depth + 1);
      else out.push({ url: child, method: "sitemap", likely_kind: guessKind(child.toLowerCase(), "") });
    }
  };
  for (const c of candidates.slice(0, 8)) await visit(c, 0);
  return out;
}

// ----------------------------------------------------------------------------
// 3. rss_atom — feed auto-detect + parse entry links.
// ----------------------------------------------------------------------------

export async function methodRssAtom(env: Env, seedUrl: string, html?: string): Promise<RawLink[]> {
  const out: RawLink[] = [];
  const feeds = new Set<string>();
  if (html) {
    for (const m of html.matchAll(/<link[^>]+rel=["']?alternate["']?[^>]*>/gi)) {
      const tag = m[0];
      if (!/type=["']application\/(rss|atom)\+xml/i.test(tag)) continue;
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (href) { try { feeds.add(new URL(href, seedUrl).toString()); } catch { /* ignore */ } }
    }
  }
  const u = canonicalizeUrl(seedUrl);
  if (u) {
    // Common defaults if discovery missed an explicit rel=alternate.
    for (const path of ["/feed", "/rss", "/atom.xml", "/feed.xml", "/index.xml"]) {
      feeds.add(`${u.scheme}://${u.host}${path}`);
    }
  }
  for (const feedUrl of [...feeds].slice(0, 5)) {
    const txt = await fetchText(env, feedUrl, 12_000);
    if (!txt) continue;
    // RSS <link>…</link> + Atom <link href="…"/>.
    for (const m of txt.matchAll(/<link[^>]*?(?:\s+href=["']([^"']+)["']|>([^<]+)<\/link>)/gi)) {
      const href = m[1] ?? m[2];
      if (!href) continue;
      out.push({ url: href.trim(), method: "rss_atom", likely_kind: "writing" });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// 4. opengraph_meta — canonical / og:url / twitter:site.
// ----------------------------------------------------------------------------

export async function methodOpengraph(_env: Env, seedUrl: string, html?: string): Promise<RawLink[]> {
  if (!html) return [];
  const out: RawLink[] = [];
  const grab = (re: RegExp, kind: string) => {
    const m = html.match(re);
    if (m?.[1]) {
      try { out.push({ url: new URL(m[1], seedUrl).toString(), method: "opengraph_meta", likely_kind: kind }); }
      catch { /* bad URL */ }
    }
  };
  grab(/<link[^>]+rel=["']?canonical["']?[^>]+href=["']([^"']+)["']/i, "canonical");
  grab(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i, "canonical");
  // twitter:site is a @handle — convert to a URL.
  const tw = html.match(/<meta[^>]+name=["']twitter:(?:site|creator)["'][^>]+content=["']@?([A-Za-z0-9_]+)["']/i);
  if (tw?.[1]) out.push({ url: `https://x.com/${tw[1]}`, method: "opengraph_meta", likely_kind: "social_handle" });
  return out;
}

// ----------------------------------------------------------------------------
// 5. jsonld_sameas — schema.org sameAs[] arrays.
// ----------------------------------------------------------------------------

export async function methodJsonLdSameAs(_env: Env, _seedUrl: string, html?: string): Promise<RawLink[]> {
  if (!html) return [];
  const out: RawLink[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let json: unknown;
    try { json = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj.sameAs)) {
        for (const v of obj.sameAs) if (typeof v === "string") out.push({ url: v, method: "jsonld_sameas", likely_kind: "social_handle" });
      } else if (typeof obj.sameAs === "string") {
        out.push({ url: obj.sameAs, method: "jsonld_sameas", likely_kind: "social_handle" });
      }
      for (const k of Object.keys(obj)) walk(obj[k]);
    };
    if (Array.isArray(json)) for (const n of json) walk(n); else walk(json);
  }
  return out;
}

// ----------------------------------------------------------------------------
// 6. archive_wayback — CDX API for historical snapshots of the seed host.
// ----------------------------------------------------------------------------

export async function methodWayback(env: Env, seedUrl: string): Promise<RawLink[]> {
  const u = canonicalizeUrl(seedUrl);
  if (!u) return [];
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(u.host)}/*&output=json&fl=original&collapse=urlkey&limit=200&filter=statuscode:200`;
  const txt = await fetchText(env, url, 20_000);
  if (!txt) return [];
  let rows: string[][] = [];
  try { rows = JSON.parse(txt) as string[][]; } catch { return []; }
  const out: RawLink[] = [];
  for (const r of rows.slice(1)) {
    const original = r?.[0];
    if (!original) continue;
    out.push({ url: original, method: "archive_wayback" });
  }
  return out;
}

// ----------------------------------------------------------------------------
// 7. sister_pages — probe /team/{slug}, /people/{slug}, /about/{slug}.
// ----------------------------------------------------------------------------

export async function methodSisterPages(_env: Env, seedUrl: string, html?: string): Promise<RawLink[]> {
  const u = canonicalizeUrl(seedUrl);
  if (!u || !html) return [];
  // If the seed already looks like /team/<slug>, propose other slugs we
  // can see linked elsewhere on the same page under sibling paths.
  const out: RawLink[] = [];
  for (const prefix of ["/team/", "/people/", "/about/", "/staff/", "/partners/", "/members/"]) {
    const re = new RegExp(`href=["']([^"']*${prefix}[A-Za-z0-9_\\-]+/?)["']`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      try {
        const abs = new URL(m[1], seedUrl).toString();
        out.push({ url: abs, method: "sister_pages", likely_kind: "bio" });
      } catch { /* ignore */ }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// 8. citations — URLs already cited in news_items bodies for the seed host.
// Cheap DB lookup, no network — uses Task #2's news ingestion corpus.
// ----------------------------------------------------------------------------

export async function methodCitations(env: Env, seedUrl: string): Promise<RawLink[]> {
  const u = canonicalizeUrl(seedUrl);
  if (!u) return [];
  try {
    const r = await env.DB.prepare(
      `SELECT body FROM news_items
        WHERE body IS NOT NULL
          AND body LIKE ?
        ORDER BY fetched_at DESC LIMIT 100`,
    ).bind(`%${u.host}%`).all<{ body: string }>();
    const seen = new Set<string>();
    const out: RawLink[] = [];
    for (const row of r.results ?? []) {
      const body = row.body ?? "";
      const re = /https?:\/\/[^\s<>"'`]+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const url = m[0].replace(/[.,;:)]+$/, "");
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ url, method: "citations" });
        if (out.length > 400) return out;
      }
    }
    return out;
  } catch {
    // news_items may not exist in some deploys yet.
    return [];
  }
}

// ----------------------------------------------------------------------------
// Public method registry — keyed for the API's `methods?` selector.
// ----------------------------------------------------------------------------

export const ALL_METHOD_NAMES = [
  "outbound", "sitemap", "rss_atom", "opengraph_meta", "jsonld_sameas",
  "archive_wayback", "sister_pages", "citations",
  // Reserved (stubbed) for future implementation. Listed here so the UI
  // can show checkboxes for them and the API accepts the names.
  "google_dorks", "common_crawl", "pdf_annotations", "social_bio",
  "linktree_beacons_carrd", "registry_links", "conference_programs",
  "foundation_filings", "scholar_profiles", "patent_links",
] as const;
export type MethodName = typeof ALL_METHOD_NAMES[number];
