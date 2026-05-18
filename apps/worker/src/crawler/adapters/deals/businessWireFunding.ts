// Task #3: BusinessWire funding RSS adapter.
//
// Source: https://www.businesswire.com/portal/site/home/news/industries/?ndmConfigId=1000045&newsLang=en&beanID=...
// We claim the simpler funding category feeds. Press wire →
// `press_release` authority tier.

import type { SiteAdapter } from "../types";
import { buildDealAdapterResult } from "./_shared";

export const businessWireFunding: SiteAdapter = {
  id: "deal_businesswire_funding",
  priority: 65,
  hosts: ["www.businesswire.com", "businesswire.com"],
  url_patterns: [
    /\/portal\/site\/home\/news\/industries\/.*\b(venture|funding|mergers)\b/i,
    /\/news\/home\/rss/i,
    /\/rss\/(funding|venture|mergers|finance)/i,
  ],
  profile_types_emitted: ["deal_announcement"],
  extract: (body, url) => buildDealAdapterResult("deal_businesswire_funding", body, url, "press_release"),
};
