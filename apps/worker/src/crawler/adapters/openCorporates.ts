// OpenCorporates adapter (free-tier rate limits; respect them in the
// engine's host throttle).

import type { SiteAdapter, AdapterResult } from "./types";
import { pickTitle, stripTags } from "./_util";

export const openCorporates: SiteAdapter = {
  id: "opencorporates_public",
  priority: 70,
  hosts: ["opencorporates.com"],
  url_patterns: [/^\/companies\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+/i, /^\/officers\/\d+/i],
  profile_types_emitted: ["founder", "board_member"],
  extract(html, url): AdapterResult {
    const title = pickTitle(html);
    const text = stripTags(html);
    const name = title.replace(/\s*::.*$/i, "").replace(/\s*\|.*$/i, "").trim() || null;
    const jurisdiction = text.match(/Jurisdiction[:\s]+([A-Za-z, ()]+)/i)?.[1]?.trim() ?? null;
    const status = text.match(/Status[:\s]+([A-Za-z ]+)/i)?.[1]?.trim() ?? null;
    const companyNo = text.match(/Company Number[:\s]+([A-Z0-9-]+)/i)?.[1] ?? null;
    const incorporation = text.match(/Incorporated\s+on[:\s]+([A-Za-z0-9, ]+)/i)?.[1]?.trim() ?? null;
    return {
      adapter_id: "opencorporates_public",
      confidence: companyNo ? 0.7 : (name ? 0.4 : 0.2),
      candidates: [{
        profile_type: null,
        confidence: companyNo ? 0.7 : 0.4,
        name, url,
        data: { company_name: name, jurisdiction, status, company_number: companyNo, incorporation_date: incorporation, opencorporates_url: url },
      }],
      child_urls: [],
    };
  },
};
