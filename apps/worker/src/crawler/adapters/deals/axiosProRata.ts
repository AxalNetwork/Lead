// Task #3: Axios Pro Rata RSS adapter.
// Source: https://api.axios.com/feed/podcast/pro-rata + axios.com tag/funding feed.

import type { SiteAdapter } from "../types";
import { buildDealAdapterResult } from "./_shared";

export const axiosProRata: SiteAdapter = {
  id: "deal_axios_pro_rata",
  priority: 55,
  hosts: ["www.axios.com", "axios.com", "api.axios.com"],
  url_patterns: [
    /\/feed\/.*pro-?rata/i,
    /\/tag\/funding/i,
    /\/tag\/deals/i,
  ],
  profile_types_emitted: ["deal_announcement"],
  extract: (body, url) => buildDealAdapterResult("deal_axios_pro_rata", body, url, "tech_press"),
};
