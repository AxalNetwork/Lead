// Task #3: VentureBeat funding RSS adapter.
// Source: https://venturebeat.com/category/funding/feed/

import type { SiteAdapter } from "../types";
import { buildDealAdapterResult } from "./_shared";

export const ventureBeatFunding: SiteAdapter = {
  id: "deal_venturebeat_funding",
  priority: 60,
  hosts: ["venturebeat.com", "www.venturebeat.com"],
  url_patterns: [
    /\/category\/funding\/feed/i,
    /\/category\/venture\/feed/i,
    /\/category\/ai\/feed/i,
  ],
  profile_types_emitted: ["deal_announcement"],
  extract: (body, url) => buildDealAdapterResult("deal_venturebeat_funding", body, url, "tech_press"),
};
