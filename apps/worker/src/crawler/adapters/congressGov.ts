// Congress.gov bills + members adapter.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickTitle, stripTags } from "./_util";

export const congressGov: SiteAdapter = {
  id: "congress_gov",
  priority: 78,
  hosts: ["congress.gov", "www.congress.gov"],
  url_patterns: [/^\/bill\//i, /^\/member\//i, /^\/committee\//i],
  profile_types_emitted: ["politician_federal"],
  extract(html, url): AdapterResult {
    const title = pickTitle(html).replace(/\s*\|\s*Congress\.gov.*$/i, "").trim();
    const text = stripTags(html);
    const isMember = /\/member\//i.test(url);
    const isBill = /\/bill\//i.test(url);
    const party = text.match(/\bParty\s*[:\-]\s*(Democratic|Republican|Independent|Libertarian|Green)/i)?.[1] ?? null;
    const state = text.match(/\bState\s*[:\-]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)(?=\s+(?:House|Senate|District|Republican|Democratic|,|\.|$))/)?.[1]?.trim() ?? null;
    const chamber = text.match(/\b(Senate|House)\b/)?.[1] ?? null;
    const sponsor = text.match(/Sponsor[:\s]+([A-Z][A-Za-z. ,]+?)\s+\[/i)?.[1]?.trim() ?? null;
    return {
      adapter_id: "congress_gov",
      confidence: (isMember || isBill) ? 0.7 : 0.3,
      candidates: [{
        profile_type: isMember ? "politician_federal" : null,
        confidence: (isMember || isBill) ? 0.7 : 0.3,
        name: title || null,
        url,
        data: {
          name: title, party, state, chamber,
          office_held: isMember ? (chamber ? `Member of ${chamber}` : "Member of Congress") : null,
          sponsor, is_bill: isBill, is_member: isMember,
          congress_url: url,
        },
      }],
      child_urls: [],
    };
  },
};
