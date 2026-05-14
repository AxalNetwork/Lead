// Build the seed URL set for a firm team crawl. We try, in order:
//   (a) sitemap.xml — keep entries whose path matches the team-page regex.
//   (b) the firm homepage — extract internal anchors whose visible text
//       matches /team|people|partner|about|leadership|founder/i.
//   (c) probe a curated list of TEAM_PATHS against the firm origin.
//
// All probes go through the Task #5 fetcher so robots.txt + ToS + per-host
// rate limiting are honored. The caller decides how many of the returned
// candidates to actually crawl (Task #17 spec caps at 8).

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

export interface SeedSet {
  /** Ordered, deduped candidate URLs to crawl. Caller caps the slice. */
  candidates: string[];
  /** Number of probe fetches we've already spent on this set. */
  probesSpent: number;
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

function dedupeUrls(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    let canonical: string;
    try {
      const url = new URL(u);
      url.hash = "";
      canonical = url.toString().replace(/\/+$/, "");
    } catch {
      continue;
    }
    const k = canonical.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(canonical);
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
 * Build a deduped, ordered set of candidate team-page URLs for a firm.
 * Performs at most 2 discovery fetches (sitemap.xml + homepage); TEAM_PATHS
 * are NOT pre-probed — the caller fetches them as part of the crawl loop
 * (and counts them toward the 8-page budget).
 */
export async function buildSeedUrls(
  env: Env,
  homepage: string,
  jobId: string,
): Promise<SeedSet> {
  const origin = originOf(homepage);
  if (!origin) return { candidates: [], probesSpent: 0 };

  let probesSpent = 0;
  const sitemapUrls: string[] = [];
  const homepageAnchors: string[] = [];

  // (a) sitemap.xml — best-effort. Failures (404, blocked, etc.) are silent.
  try {
    const sm = await fetchPage(env, `${origin}/sitemap.xml`, { jobId, minIntervalMs: 1000 });
    probesSpent += 1;
    if (sm.ok && sm.html) {
      sitemapUrls.push(...extractSitemapMatches(sm.html));
    }
  } catch {
    // ignore
  }

  // (b) homepage anchor scan — also best-effort.
  try {
    const hp = await fetchPage(env, homepage, { jobId, minIntervalMs: 1000 });
    probesSpent += 1;
    if (hp.ok && hp.html) {
      homepageAnchors.push(...extractAnchorMatches(hp.html, hp.url || homepage));
    }
  } catch {
    // ignore
  }

  // (c) curated TEAM_PATHS — synthesized; the crawl loop fetches them.
  const probedPaths = TEAM_PATHS.map((p) => `${origin}${p}`);

  // Order: explicit anchors first (operator-curated nav links), then
  // sitemap discoveries, then the curated path probes. Homepage itself
  // last as a fallback so we still extract from /index when no /team page
  // exists.
  const candidates = dedupeUrls([
    ...homepageAnchors,
    ...sitemapUrls,
    ...probedPaths,
    homepage,
  ]);

  return { candidates, probesSpent };
}
