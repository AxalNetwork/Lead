// Think-tank fellow-roster adapter — Brookings, AEI, Heritage, CFR,
// RAND. Treats /experts/ / /scholars/ pages as directories, individual
// profile pages as fellows.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { pickMeta, pickTitle, collectLinks, safeHost, stripTags, isSameRegistrableHost } from "./_util";

const THINK_TANK_HOSTS = [
  "brookings.edu", "www.brookings.edu",
  "aei.org", "www.aei.org",
  "heritage.org", "www.heritage.org",
  "cfr.org", "www.cfr.org",
  "rand.org", "www.rand.org",
];

export const thinkTankRosters: SiteAdapter = {
  id: "think_tank_rosters",
  priority: 72,
  hosts: THINK_TANK_HOSTS,
  url_patterns: [/\/experts?\//i, /\/scholars?\//i, /\/fellows?\//i, /\/people\//i, /\/staff\//i],
  profile_types_emitted: ["policy_advisor", "advisor", "research_scientist"],
  extract(html, url): AdapterResult {
    const candidates: AdapterCandidate[] = [];
    const host = safeHost(url);
    const text = stripTags(html);
    const isDirectory = /\/experts\/?$|\/scholars\/?$|\/fellows\/?$|\/people\/?$|\/staff\/?$/i.test(new URL(url).pathname);

    if (isDirectory) {
      const links = collectLinks(html, url).filter((u) => {
        try {
          const lu = new URL(u);
          return isSameRegistrableHost(u, host)
            && /\/(experts|scholars|fellows|people|staff)\/[^/]+$/i.test(lu.pathname);
        } catch { return false; }
      });
      // Each link is a candidate fellow.
      for (const link of links.slice(0, 200)) {
        const slug = decodeURIComponent(new URL(link).pathname.split("/").filter(Boolean).pop() || "");
        const name = slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        candidates.push({
          profile_type: "policy_advisor",
          confidence: 0.5,
          name, url: link,
          data: { name, source_directory: url, think_tank_host: host },
        });
      }
      return {
        adapter_id: "think_tank_rosters",
        confidence: candidates.length ? 0.6 : 0.2,
        candidates,
        child_urls: links.slice(0, 200),
      };
    }

    const title = pickMeta(html, "og:title") || pickTitle(html);
    const name = title.replace(/\s*\|.*$/, "").replace(/\s*-\s*[A-Z].*$/, "").trim() || null;
    const bio = pickMeta(html, "og:description") || "";
    const role = text.match(/\b(Senior Fellow|Fellow|Distinguished Fellow|Director|President|Vice President|Scholar|Research Fellow)\b[^.]{0,80}/i)?.[0] ?? null;
    return {
      adapter_id: "think_tank_rosters",
      confidence: name ? 0.65 : 0.25,
      candidates: [{
        profile_type: "policy_advisor",
        confidence: name ? 0.65 : 0.25,
        name, url,
        data: { name, role, bio, institution: host.replace(/^www\./, "").split(".")[0], profile_url: url },
      }],
      child_urls: [],
    };
  },
};
