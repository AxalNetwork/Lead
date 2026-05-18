// openFEC adapter. Donor / recipient pages on fec.gov. Pure HTML
// parsing — the official openFEC REST API is consumed by a separate
// service.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickTitle, stripTags } from "./_util";

export const fec: SiteAdapter = {
  id: "fec_public",
  priority: 70,
  hosts: ["fec.gov", "www.fec.gov", "api.open.fec.gov"],
  url_patterns: [/\/data\/(?:committee|candidate|receipts|disbursements)/i, /\/data\/individual-contributions/i],
  profile_types_emitted: ["politician_federal"],
  extract(html, url): AdapterResult {
    const title = pickTitle(html);
    const text = stripTags(html);
    const name = title.replace(/\s*[-|]\s*FEC.*$/i, "").trim() || null;
    const cycle = text.match(/\b(20\d{2})\s*cycle\b/i)?.[1] ?? null;
    const totalRaised = text.match(/Total\s+raised[:\s]+\$([\d,.]+)/i)?.[1] ?? null;
    const totalSpent = text.match(/Total\s+spent[:\s]+\$([\d,.]+)/i)?.[1] ?? null;
    return {
      adapter_id: "fec_public",
      confidence: name ? 0.55 : 0.2,
      candidates: [{
        profile_type: null,
        confidence: name ? 0.55 : 0.2,
        name, url,
        data: { name, cycle, total_raised: totalRaised, total_spent: totalSpent, fec_url: url },
      }],
      child_urls: [],
    };
  },
};
