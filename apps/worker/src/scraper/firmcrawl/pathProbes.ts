// Build the seed URL set for a firm team crawl. We try, in order:
//   (a) the firm homepage — extract internal anchors whose visible text or
//       href matches /team|people|partner|about|leadership|founder/i.
//   (b) sitemap.xml — keep URLs whose path matches the team-page regex.
//   (c) actively probe a curated list of TEAM_PATHS against the firm origin
//       via the tiered fetcher. Tier-0 404 does NOT escalate (the fetcher's
//       `shouldEscalate` whitelist excludes status_404), so each missing
//       path costs exactly one Tier-0 request.
//
// All probes go through the Task #5 fetcher so robots.txt + ToS + per-host
// rate limiting are honored. We return the actual `{url, html}` of every
// successfully fetched page so the caller does not need to re-fetch.

import type { Env } from "../../types";
import { fetchPage } from "../fetcher";

/**
 * Ordered list of likely team-page paths. Longest / most specific first so
 * a hit on `/our-team` is preferred over `/about` when both exist.
 */
export const TEAM_PATHS: string[] = [
  "/team",
  "/people",
  "/our-team",
  "/our-people",
  "/the-team",
  "/who-we-are",
  "/partners",
  "/investors",
  "/investment-team",
  "/leadership",
  "/staff",
  "/principals",
  "/about/team",
  "/about/people",
  "/about/leadership",
  "/about-us/team",
  "/company/team",
  "/about",
  "/about-us",
];

const TEAM_RE = /team|people|partner|about|leadership|staff|principal|founder/i;
const ANCHOR_RE = /<a\s+[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const SITEMAP_LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
const TAG_STRIP = /<[^>]+>/g;

export interface FetchedPage {
  url: string;
  html: string;
}

export interface SeedSet {
  /** Pages that returned 200 (homepage + verified team pages), in order. */
  pages: FetchedPage[];
  /** Total fetcher requests spent on this discovery (including misses). */
  probesSpent: number;
  /** Total candidate URLs considered before the page cap. */
  candidatesConsidered: number;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

function canonicalize(u: string): string | null {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function dedupeUrls(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    const c = canonicalize(u);
    if (!c) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function extractAnchorMatches(html: string, base: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(TAG_STRIP, " ").replace(/\s+/g, " ").trim();
    if (!href) continue;
    if (!TEAM_RE.test(text) && !TEAM_RE.test(href)) continue;
    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!sameOrigin(absolute, base)) continue;
    out.push(absolute);
  }
  return out;
}

function extractSitemapMatches(xml: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SITEMAP_LOC_RE.lastIndex = 0;
  while ((m = SITEMAP_LOC_RE.exec(xml)) !== null) {
    const loc = m[1];
    if (TEAM_RE.test(loc)) out.push(loc);
  }
  return out;
}

/**
 * Build a fetched-and-verified set of team-page candidates for a firm.
 * Returns up to `maxPages` pages with HTML payloads so the caller can run
 * the extractor without re-fetching. Discovery probes (sitemap + non-200
 * TEAM_PATHS) are counted in `probesSpent` but do NOT consume the page
 * budget.
 */
export async function buildSeedUrls(
  env: Env,
  homepage: string,
  jobId: string,
  maxPages = 8,
): Promise<SeedSet> {
  const origin = originOf(homepage);
  if (!origin) return { pages: [], probesSpent: 0, candidatesConsidered: 0 };

  const pages: FetchedPage[] = [];
  let probesSpent = 0;
  const homepageCanonical = canonicalize(homepage) ?? homepage;
  const seenUrls = new Set<string>();

  // (a) Homepage — always our first fetch. The HTML doubles as the source
  // for the anchor scan and as a fallback team listing on small firm sites.
  const hp = await fetchPage(env, homepage, { jobId, minIntervalMs: 1500, liveOnly: true });
  probesSpent += 1;
  let homepageAnchors: string[] = [];
  if (hp.ok && hp.html) {
    pages.push({ url: hp.url || homepage, html: hp.html });
    seenUrls.add((hp.url || homepageCanonical).toLowerCase());
    homepageAnchors = extractAnchorMatches(hp.html, hp.url || homepage);
  }

  // (b) sitemap.xml — discovery only, never extracted from.
  let sitemapMatches: string[] = [];
  try {
    const sm = await fetchPage(env, `${origin}/sitemap.xml`, { jobId, minIntervalMs: 1500, liveOnly: true });
    probesSpent += 1;
    if (sm.ok && sm.html) sitemapMatches = extractSitemapMatches(sm.html);
  } catch {
    // ignore — sitemap is optional
  }

  // (c) Build the probe queue: anchors first (operator-curated nav),
  // then sitemap discoveries, then the curated TEAM_PATHS. Dedupe
  // against the homepage and itself.
  const probedPaths = TEAM_PATHS.map((p) => `${origin}${p}`);
  const queue = dedupeUrls([...homepageAnchors, ...sitemapMatches, ...probedPaths])
    .filter((u) => !seenUrls.has(u.toLowerCase()));

  // Actively probe each candidate via the tiered fetcher. Two safeguards
  // keep a missing /team path from contaminating the seed set:
  //   1. The fetcher's `shouldEscalate` whitelist excludes status_404, so
  //      a missing curated path costs one Tier-0 request and does not
  //      trigger browser/proxy escalation.
  //   2. `liveOnly: true` bypasses the Brave Search cache (tier 5) and
  //      Wayback Machine (tier 4) fallback chain entirely, so an archived
  //      snapshot of a now-removed /team page can never be returned as a
  //      live seed page. Defensive: also reject any non-"live"
  //      fetched_from in the result.
  for (const url of queue) {
    if (pages.length >= maxPages) break;
    let r;
    try {
      r = await fetchPage(env, url, { jobId, minIntervalMs: 1500, liveOnly: true });
    } catch {
      probesSpent += 1;
      continue;
    }
    probesSpent += 1;
    if (r.ok && r.html && r.fetched_from === "live") {
      const key = (r.url || url).toLowerCase();
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      pages.push({ url: r.url || url, html: r.html });
    }
  }

  return { pages, probesSpent, candidatesConsidered: queue.length + 1 };
}
