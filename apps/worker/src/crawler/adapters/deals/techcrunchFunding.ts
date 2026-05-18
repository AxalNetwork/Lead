// Task #3: TechCrunch funding RSS adapter.
//
// Source: https://techcrunch.com/category/venture/feed/
// Also claims the alternative /funding/ category. Tech press →
// `tech_press` authority tier (lowest in the SEC > company blog >
// press release > tech press hierarchy).

import type { SiteAdapter } from "../types";
import { buildDealAdapterResult } from "./_shared";

export const techcrunchFunding: SiteAdapter = {
  id: "deal_techcrunch_funding",
  priority: 60,
  hosts: ["techcrunch.com", "www.techcrunch.com"],
  url_patterns: [
    /\/category\/venture\/feed/i,
    /\/category\/funding\/feed/i,
    /\/category\/startups\/feed/i,
    /\/tag\/funding\/feed/i,
  ],
  profile_types_emitted: ["deal_announcement"],
  extract: (body, url) => buildDealAdapterResult("deal_techcrunch_funding", body, url, "tech_press"),
};
