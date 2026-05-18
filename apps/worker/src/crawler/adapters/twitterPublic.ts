// Twitter/X public profile adapter. Twitter's main app is JS-rendered
// and aggressively blocks bots, so the engine typically ends up with
// either (a) the OG-metadata stub Twitter ships in the initial HTML
// for unauth requests, or (b) a Nitter mirror snapshot. Both are
// handled here.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { pickMeta, pickTitle, stripTags } from "./_util";

const HANDLE_RE = /^\/([A-Za-z0-9_]{1,15})\/?$/;

export const twitterPublic: SiteAdapter = {
  id: "twitter_public",
  priority: 70,
  hosts: ["twitter.com", "x.com", "mobile.twitter.com", "nitter.net"],
  url_patterns: [/^\/[A-Za-z0-9_]{1,15}\/?$/],
  profile_types_emitted: ["firm_person"],
  extract(html, url): AdapterResult {
    let handle: string | null = null;
    try {
      const u = new URL(url);
      const m = HANDLE_RE.exec(u.pathname);
      if (m) handle = m[1];
    } catch { /* ignore */ }
    if (!handle) return { adapter_id: "twitter_public", confidence: 0, candidates: [], child_urls: [] };

    const name = pickMeta(html, "og:title")?.replace(/\s*\(.*\)\s*$/, "").replace(/\s*\/\s*X.*$/, "").trim()
      || pickTitle(html).replace(/\s*\/\s*Twitter.*$/, "").trim();
    const bio = pickMeta(html, "og:description") || pickMeta(html, "description") || "";
    const image = pickMeta(html, "og:image");

    // Nitter / Twitter stats: try to scrape follower count from the
    // visible text. Format examples: "1,234 Followers" or "Followers 1.2K".
    const text = stripTags(html);
    const followers = text.match(/(\d[\d,.]*[KMB]?)\s+Followers/i)?.[1]
      ?? text.match(/Followers\s+(\d[\d,.]*[KMB]?)/i)?.[1] ?? null;

    const candidate: AdapterCandidate = {
      profile_type: "firm_person",
      confidence: name ? 0.55 : 0.25,
      name: name || handle,
      url,
      data: {
        name: name || null,
        twitter_handle: handle,
        bio,
        followers,
        profile_photo: image,
        socials: [{ platform: "twitter", url: `https://twitter.com/${handle}` }],
      },
    };
    return { adapter_id: "twitter_public", confidence: candidate.confidence, candidates: [candidate], child_urls: [] };
  },
};
