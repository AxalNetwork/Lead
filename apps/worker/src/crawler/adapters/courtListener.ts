// CourtListener federal court records adapter.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickTitle, stripTags } from "./_util";

export const courtListener: SiteAdapter = {
  id: "courtlistener",
  priority: 70,
  hosts: ["courtlistener.com", "www.courtlistener.com"],
  url_patterns: [/^\/docket\/\d+/i, /^\/opinion\/\d+/i, /^\/person\/\d+/i],
  profile_types_emitted: ["lawyer"],
  extract(html, url): AdapterResult {
    const title = pickTitle(html).replace(/\s*\|\s*CourtListener.*$/i, "").trim();
    const text = stripTags(html);
    const court = text.match(/Court[:\s]+([A-Za-z .]+(?:Court|District)[A-Za-z .]*)/i)?.[1]?.trim() ?? null;
    const docketNo = text.match(/Docket\s+(?:No\.|Number)[:\s]+([A-Za-z0-9:-]+)/i)?.[1] ?? null;
    const date = text.match(/Date Filed[:\s]+(\w+\s+\d{1,2},\s+\d{4})/i)?.[1] ?? null;
    return {
      adapter_id: "courtlistener",
      confidence: (court || docketNo) ? 0.6 : 0.2,
      candidates: [{
        profile_type: null,
        confidence: (court || docketNo) ? 0.6 : 0.2,
        name: title || null,
        url,
        data: { case_name: title, court, docket_no: docketNo, date_filed: date, courtlistener_url: url },
      }],
      child_urls: [],
    };
  },
};
