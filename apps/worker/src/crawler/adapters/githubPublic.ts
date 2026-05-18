// GitHub public user / org page adapter. Extracts from the rendered
// HTML (the engine has already fetched it). For richer data the
// downstream workflow may also hit the public REST API directly — that
// lives outside this adapter.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { pickMeta, pickTitle, stripTags } from "./_util";

const USER_RE = /^\/(?!orgs\/|topics\/|search|features|marketplace|pricing|sponsors|settings|trending|collections)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/?$/;
const ORG_RE = /^\/orgs\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/?/;

export const githubPublic: SiteAdapter = {
  id: "github_public",
  priority: 80,
  hosts: ["github.com", "www.github.com"],
  url_patterns: [USER_RE, ORG_RE],
  profile_types_emitted: ["firm_person", "operator_engineering"],
  extract(html, url): AdapterResult {
    let handle: string | null = null;
    let isOrg = false;
    try {
      const u = new URL(url);
      const userM = USER_RE.exec(u.pathname);
      const orgM = ORG_RE.exec(u.pathname);
      if (orgM) { handle = orgM[1]; isOrg = true; }
      else if (userM) { handle = userM[1]; }
    } catch { /* ignore */ }
    if (!handle) return { adapter_id: "github_public", confidence: 0, candidates: [], child_urls: [] };

    const title = pickTitle(html);
    const ogTitle = pickMeta(html, "og:title") || title;
    const bio = pickMeta(html, "og:description") || pickMeta(html, "description") || "";
    const image = pickMeta(html, "og:image");
    const text = stripTags(html);

    // GitHub displays follower / following counts inline. Look for them.
    const followers = text.match(/(\d[\d,]*)\s+follower/i)?.[1] ?? null;
    const location = pickMeta(html, "profile:location") || (text.match(/Location[:\s]+([A-Z][A-Za-z ,]+)/)?.[1] ?? null);

    const candidate: AdapterCandidate = {
      profile_type: isOrg ? null : "firm_person",
      confidence: ogTitle ? 0.7 : 0.3,
      name: ogTitle.replace(/^.*?·\s*/, "").trim() || handle,
      url,
      data: {
        name: ogTitle || null,
        github_login: handle,
        github_url: `https://github.com/${isOrg ? "orgs/" + handle : handle}`,
        bio, location, followers,
        avatar_url: image,
        socials: [{ platform: "github", url }],
        is_org: isOrg,
      },
    };
    return { adapter_id: "github_public", confidence: candidate.confidence, candidates: [candidate], child_urls: [] };
  },
};
