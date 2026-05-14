// X / Twitter profile parser. We never hit twitter.com or x.com directly —
// both are JS-rendered and aggressively rate-limit. Instead we rewrite to
// the public Nitter mirror (configurable via env.NITTER_BASE) and parse
// bio, location, website, joined date, and follower count from the
// server-rendered HTML.

import type { Env, ParsedLead } from "../../../types";
import type { FetchResult } from "../../fetcher";
import { fetchPage } from "../../fetcher";
import { extractDomain } from "../../normalize";
import { decodeEntities, stripTags } from "../../html";

const TWITTER_HOST_RE = /^(?:www\.)?(twitter|x)\.com$/i;
const HANDLE_RE = /^\/(?!i\/|home|explore|search|notifications)([A-Za-z0-9_]{1,15})\/?$/;

export function isTwitterProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return TWITTER_HOST_RE.test(u.hostname) && HANDLE_RE.test(u.pathname);
  } catch {
    return false;
  }
}

export function handleFromTwitterUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = HANDLE_RE.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function nitterUrlFor(handle: string, base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/${handle}`;
}

function pickMeta(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\s+[^>]*(?:name|property)\\s*=\\s*[\"']${name}[\"'][^>]*content\\s*=\\s*[\"']([^\"']+)[\"']`, "i");
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : null;
}

function pickClass(html: string, cls: string): string | null {
  const re = new RegExp(`<[^>]+class=\"[^\"]*\\b${cls}\\b[^\"]*\"[^>]*>([\\s\\S]*?)<\/`, "i");
  const m = re.exec(html);
  return m ? decodeEntities(stripTags(m[1])).trim() || null : null;
}

function parseFollowerCount(html: string): number | null {
  // Nitter exposes follower count in a "Followers" stat block:
  //   <li class="followers"><span class="profile-stat-num">12,345</span> Followers</li>
  const m = /<li[^>]*class="[^"]*followers[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*profile-stat-num[^"]*"[^>]*>([^<]+)</i.exec(html);
  if (!m) return null;
  const n = Number(m[1].replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseJoined(html: string): string | null {
  const m = /<div[^>]*class="[^"]*profile-joindate[^"]*"[^>]*>[\s\S]*?title="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

function parseWebsiteHref(html: string): string | null {
  const m = /<div[^>]*class="[^"]*profile-website[^"]*"[^>]*>[\s\S]*?href="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

export interface NitterParseResult {
  leads: ParsedLead[];
  fetched: FetchResult | null;
}

export async function parseTwitter(env: Env, url: string, jobId: string): Promise<NitterParseResult> {
  const handle = handleFromTwitterUrl(url);
  if (!handle) return { leads: [], fetched: null };
  const base = (env.NITTER_BASE && env.NITTER_BASE.trim()) || "https://nitter.net";
  const target = nitterUrlFor(handle, base);
  const fetched = await fetchPage(env, target, { jobId, minIntervalMs: 1500 });
  if (!fetched.ok || !fetched.html) {
    return {
      leads: [
        {
          source_domain: extractDomain(url),
          source_url: url,
          name: handle,
          category: "twitter_profile",
          meta: {
            parser: "profile/nitter",
            twitter_handle: handle,
            nitter_url: target,
            nitter_block_reason: fetched.blockReason,
          },
        },
      ],
      fetched,
    };
  }
  const html = fetched.html;
  const display = pickMeta(html, "og:title") || pickClass(html, "profile-card-fullname") || handle;
  const bio = pickMeta(html, "og:description") || pickClass(html, "profile-bio");
  const location = pickClass(html, "profile-location");
  const website = parseWebsiteHref(html);
  const joined = parseJoined(html);
  const followers = parseFollowerCount(html);

  return {
    leads: [
      {
        source_domain: extractDomain(url),
        source_url: url,
        name: display.replace(/^@/, "").trim() || handle,
        category: "twitter_profile",
        meta: {
          parser: "profile/nitter",
          twitter_handle: handle,
          twitter_url: url,
          nitter_url: target,
          bio,
          location,
          website,
          joined,
          follower_count: followers,
          socials: [
            { platform: "twitter", url },
            ...(website ? [{ platform: "personal", url: website }] : []),
          ],
        },
      },
    ],
    fetched,
  };
}
