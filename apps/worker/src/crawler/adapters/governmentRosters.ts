// US government program-manager / staff roster adapter.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { pickMeta, pickTitle, collectLinks, safeHost, stripTags, isSameRegistrableHost } from "./_util";

const GOV_HOSTS = [
  "darpa.mil", "www.darpa.mil",
  "arpa-e.energy.gov", "www.arpa-e.energy.gov",
  "nsf.gov", "www.nsf.gov",
  "niaid.nih.gov", "www.niaid.nih.gov",
  "energy.gov", "www.energy.gov",
];

export const governmentRosters: SiteAdapter = {
  id: "government_rosters",
  priority: 72,
  hosts: GOV_HOSTS,
  url_patterns: [/\/program-manager/i, /\/program-directors?/i, /\/staff\//i, /\/leadership/i, /\/people\//i],
  profile_types_emitted: ["policy_advisor", "government_agency_federal"],
  extract(html, url): AdapterResult {
    const candidates: AdapterCandidate[] = [];
    const text = stripTags(html);
    const host = safeHost(url);

    // Directory pages: collect profile links.
    const isDirectory = /\/program-managers?\/?$|\/staff\/?$|\/leadership\/?$|\/people\/?$/i.test(new URL(url).pathname);
    if (isDirectory) {
      const links = collectLinks(html, url).filter((u) => {
        try {
          const lu = new URL(u);
          return isSameRegistrableHost(u, host)
            && /\/(staff|people|program-managers?|leadership)\/[^/]+$/i.test(lu.pathname);
        } catch { return false; }
      });
      for (const link of links.slice(0, 200)) {
        const slug = decodeURIComponent(new URL(link).pathname.split("/").filter(Boolean).pop() || "");
        const name = slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        candidates.push({
          profile_type: "policy_advisor",
          confidence: 0.5, name, url: link,
          data: { name, agency_name: host.replace(/^www\./, ""), source_directory: url },
        });
      }
      return { adapter_id: "government_rosters", confidence: candidates.length ? 0.6 : 0.2, candidates, child_urls: links.slice(0, 200) };
    }

    const title = pickMeta(html, "og:title") || pickTitle(html);
    const name = title.replace(/\s*\|.*$/, "").trim() || null;
    const bio = pickMeta(html, "og:description") || "";
    const role = text.match(/\b(Program Manager|Program Director|Director|Deputy Director|Branch Chief|Assistant Director)\b[^.]{0,80}/i)?.[0] ?? null;
    return {
      adapter_id: "government_rosters",
      confidence: name ? 0.6 : 0.2,
      candidates: [{
        profile_type: "policy_advisor",
        confidence: name ? 0.6 : 0.2,
        name, url,
        data: { name, role, bio, agency_name: host.replace(/^www\./, ""), profile_url: url },
      }],
      child_urls: [],
    };
  },
};
