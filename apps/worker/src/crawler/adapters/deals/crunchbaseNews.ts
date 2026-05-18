// Task #3: Crunchbase News (free RSS) funding adapter.
//
// Source: https://news.crunchbase.com/feed/
// Note: this is the FREE editorial feed (news.crunchbase.com), NOT the
// commercial Crunchbase Pro API (which is explicitly forbidden by the
// task spec). Tech press → `tech_press` authority tier.

import type { SiteAdapter } from "../types";
import { buildDealAdapterResult } from "./_shared";

export const crunchbaseNews: SiteAdapter = {
  id: "deal_crunchbase_news",
  priority: 60,
  hosts: ["news.crunchbase.com"],
  url_patterns: [/\/feed\/?$/i, /\/feed\/?\?/i],
  profile_types_emitted: ["deal_announcement"],
  extract: (body, url) => buildDealAdapterResult("deal_crunchbase_news", body, url, "tech_press"),
};
