// Semantic Scholar paper / author adapter.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickMeta, pickTitle, stripTags } from "./_util";

export const semanticScholar: SiteAdapter = {
  id: "semantic_scholar",
  priority: 70,
  hosts: ["www.semanticscholar.org", "semanticscholar.org"],
  url_patterns: [/^\/paper\//i, /^\/author\//i],
  profile_types_emitted: ["research_scientist", "professor"],
  extract(html, url): AdapterResult {
    const title = pickMeta(html, "og:title") || pickTitle(html).replace(/\s*\|\s*Semantic Scholar.*$/i, "").trim();
    const description = pickMeta(html, "og:description") || "";
    const text = stripTags(html);
    const citations = text.match(/(\d[\d,]*)\s+Citations/i)?.[1] ?? null;
    const hIndex = text.match(/h-index[:\s]+(\d+)/i)?.[1] ?? null;
    const isPaper = /\/paper\//i.test(url);
    return {
      adapter_id: "semantic_scholar",
      confidence: title ? 0.6 : 0.25,
      candidates: [{
        profile_type: isPaper ? null : "research_scientist",
        confidence: title ? 0.6 : 0.25,
        name: title || null,
        url,
        data: { title, description, citations, h_index: hIndex, semantic_scholar_url: url },
      }],
      child_urls: [],
    };
  },
};
