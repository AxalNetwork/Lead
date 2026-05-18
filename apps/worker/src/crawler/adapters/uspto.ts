// USPTO PatentsView + TESS trademark adapter.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickTitle, stripTags } from "./_util";

export const uspto: SiteAdapter = {
  id: "uspto_public",
  priority: 70,
  hosts: ["uspto.gov", "www.uspto.gov", "patft.uspto.gov", "tsdr.uspto.gov", "patentsview.org"],
  url_patterns: [/\/patent\//i, /\/trademark/i, /netacgi\/nph-Parser/i, /\/api\/patents\//i],
  profile_types_emitted: ["company_founder", "founder"],
  extract(html, url): AdapterResult {
    const title = pickTitle(html);
    const text = stripTags(html);
    const patentNo = text.match(/\bUS\s*(\d{7,8})\b/)?.[1] ?? null;
    const inventor = text.match(/Inventor[s]?:\s*([A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+)?)/)?.[1]?.trim() ?? null;
    const assignee = text.match(/Assignee:\s*([A-Z][A-Za-z0-9 .,'&-]+)/)?.[1]?.trim() ?? null;
    const filedDate = text.match(/Filed:?\s*(\w+\s+\d{1,2},\s+\d{4})/)?.[1] ?? null;
    return {
      adapter_id: "uspto_public",
      confidence: (patentNo || inventor) ? 0.6 : 0.25,
      candidates: [{
        profile_type: null,
        confidence: (patentNo || inventor) ? 0.6 : 0.25,
        name: title.replace(/\s*[-|]\s*USPTO.*$/i, "").trim() || null,
        url,
        data: { patent_number: patentNo, inventor, assignee, filed: filedDate, uspto_url: url },
      }],
      child_urls: [],
    };
  },
};
