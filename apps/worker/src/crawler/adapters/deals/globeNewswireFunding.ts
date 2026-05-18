// Task #3: GlobeNewswire funding RSS adapter.
//
// Source: https://www.globenewswire.com/rssfeed/industry/Financial%20Services
// Press wire → `press_release` authority tier.

import type { SiteAdapter } from "../types";
import { buildDealAdapterResult } from "./_shared";

export const globeNewswireFunding: SiteAdapter = {
  id: "deal_globenewswire_funding",
  priority: 65,
  hosts: ["www.globenewswire.com", "globenewswire.com"],
  url_patterns: [
    /\/rssfeed\/industry\/Financial(%20|\+)?Services/i,
    /\/rss\/industry\/venture/i,
    /\/rss\/category\/(funding|venture|m-and-a|mergers)/i,
  ],
  profile_types_emitted: ["deal_announcement"],
  extract: (body, url) => buildDealAdapterResult("deal_globenewswire_funding", body, url, "press_release"),
};
