// Task #3: PR Newswire funding RSS adapter.
//
// Source: https://www.prnewswire.com/rss/financial-services/venture-capital-news.rss
// (also financing-agreements, mergers-acquisitions). Wire-distributed
// press releases → `press_release` authority tier (above tech press,
// below company blogs).

import type { SiteAdapter } from "../types";
import { buildDealAdapterResult } from "./_shared";

export const prNewswireFunding: SiteAdapter = {
  id: "deal_prnewswire_funding",
  priority: 65,
  hosts: ["www.prnewswire.com", "prnewswire.com"],
  url_patterns: [
    /\/rss\/financial-services\/venture-capital/i,
    /\/rss\/financial-services\/financing-agreements/i,
    /\/rss\/financial-services\/mergers-acquisitions/i,
    /\/rss\/financial-services\/private-equity/i,
  ],
  profile_types_emitted: ["deal_announcement"],
  extract: (body, url) => buildDealAdapterResult("deal_prnewswire_funding", body, url, "press_release"),
};
