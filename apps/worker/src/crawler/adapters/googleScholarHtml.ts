// Google Scholar profile page HTML adapter. Heavily rate-limited
// upstream — engine's host throttle must enforce a slow cadence.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickTitle, stripTags } from "./_util";

export const googleScholarHtml: SiteAdapter = {
  id: "google_scholar_html",
  priority: 70,
  hosts: ["scholar.google.com", "scholar.google.co.uk", "scholar.google.ca"],
  url_patterns: [/^\/citations\?user=/i],
  profile_types_emitted: ["research_scientist", "professor"],
  extract(html, url): AdapterResult {
    const name = html.match(/<div\s+id=["']gsc_prf_in["'][^>]*>([^<]+)</i)?.[1]?.trim() ?? null;
    const affiliation = html.match(/<div\s+class=["']gsc_prf_il["'][^>]*>([^<]+)</i)?.[1]?.trim() ?? null;
    const text = stripTags(html);
    const citations = text.match(/Citations\s+(\d[\d,]*)/)?.[1] ?? null;
    const hIndex = text.match(/h-index\s+(\d+)/i)?.[1] ?? null;
    const interests: string[] = [];
    const intRe = /<a[^>]+class=["']gsc_prf_inta[^"']*["'][^>]*>([^<]+)</gi;
    let m: RegExpExecArray | null;
    while ((m = intRe.exec(html))) interests.push(m[1].trim());
    return {
      adapter_id: "google_scholar_html",
      confidence: name ? 0.8 : 0.3,
      candidates: [{
        profile_type: "research_scientist",
        confidence: name ? 0.8 : 0.3,
        name: name || pickTitle(html) || null,
        url,
        data: { name, affiliation, citations, h_index: hIndex, interests, scholar_url: url },
      }],
      child_urls: [],
    };
  },
};
