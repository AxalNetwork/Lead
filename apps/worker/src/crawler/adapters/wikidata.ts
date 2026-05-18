// Wikidata entity adapter — parses the HTML entity page; richer
// programmatic access is via the Wikidata REST API (separate service).

import type { SiteAdapter, AdapterResult } from "./types";
import { pickTitle, stripTags } from "./_util";

export const wikidata: SiteAdapter = {
  id: "wikidata",
  priority: 72,
  hosts: ["wikidata.org", "www.wikidata.org"],
  url_patterns: [/^\/wiki\/Q\d+/i, /^\/entity\/Q\d+/i],
  profile_types_emitted: ["firm_person", "investor_vc", "public_company"],
  extract(html, url): AdapterResult {
    const qid = url.match(/(Q\d+)/)?.[1] ?? null;
    const title = pickTitle(html).replace(/\s*-\s*Wikidata.*$/i, "").trim();
    const text = stripTags(html);
    const description = text.match(/\b(?:human|company|organization|investor|fund)\b[^.]*\./i)?.[0] ?? null;
    return {
      adapter_id: "wikidata",
      confidence: qid ? 0.7 : 0.2,
      candidates: [{
        profile_type: null,
        confidence: qid ? 0.7 : 0.2,
        name: title || null,
        url,
        data: { qid, name: title, description, wikidata_url: url },
      }],
      child_urls: [],
    };
  },
};
