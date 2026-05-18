// Shared conference-page extractor. Every conference HTML page is
// approximated as either a speaker list (many <a> with /speakers/<slug>)
// or an individual speaker page (single name + bio). This is a thin
// extractor — the real richness lives in per-event adapters when the
// site warrants it.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "../types";
import { pickMeta, pickTitle, stripTags, collectLinks, safeHost, isSameRegistrableHost } from "../_util";

interface ConfSpec {
  id: string;
  hosts: string[];
  url_patterns: RegExp[];
  event_name: string;
}

function nameFromSlug(slug: string): string {
  return decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export function makeConferenceAdapter(spec: ConfSpec): SiteAdapter {
  return {
    id: spec.id,
    priority: 65,
    hosts: spec.hosts,
    url_patterns: spec.url_patterns,
    profile_types_emitted: ["conference_organizer", "firm_person"],
    extract(html, url): AdapterResult {
      const candidates: AdapterCandidate[] = [];
      const host = safeHost(url);
      let path = "/";
      try { path = new URL(url).pathname; } catch { /* ignore */ }
      const isIndex = /\/(speakers?|agenda|sessions?|program|companies?|talks?)\/?$/i.test(path);
      const links = collectLinks(html, url);
      if (isIndex) {
        const seen = new Set<string>();
        for (const link of links) {
          try {
            const lu = new URL(link);
            if (!isSameRegistrableHost(link, host)) continue;
            const segs = lu.pathname.split("/").filter(Boolean);
            if (segs.length < 2) continue;
            const containerOk = /^(speakers?|agenda|sessions?|program|companies?|talks?)$/i.test(segs[0]);
            if (!containerOk) continue;
            const slug = segs[1];
            if (slug.length < 2 || seen.has(slug)) continue;
            seen.add(slug);
            const name = nameFromSlug(slug);
            candidates.push({
              profile_type: "firm_person",
              confidence: 0.45,
              name, url: lu.toString(),
              data: { name, event_name: spec.event_name, source_directory: url },
            });
          } catch { /* skip */ }
          if (candidates.length >= 250) break;
        }
      }
      // Individual page (or as a fallback when no index links were
      // found): pull the title.
      if (!candidates.length) {
        const title = pickMeta(html, "og:title") || pickTitle(html);
        const name = title.replace(/\s*[|\-–—].*$/, "").trim() || null;
        const bio = stripTags(html.slice(0, 4000)).slice(0, 600);
        candidates.push({
          profile_type: "firm_person",
          confidence: name ? 0.45 : 0.2,
          name, url,
          data: { name, event_name: spec.event_name, bio, profile_url: url },
        });
      }
      const childUrls = candidates.map((c) => c.url).filter((u): u is string => !!u);
      return {
        adapter_id: spec.id,
        confidence: candidates.length > 1 ? 0.6 : candidates[0]?.confidence ?? 0,
        candidates,
        child_urls: childUrls.length > 1 ? childUrls : [],
      };
    },
  };
}
