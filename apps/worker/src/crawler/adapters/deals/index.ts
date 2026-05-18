// Task #3: Registry of deal-feed adapters.
//
// Re-exported into the global ADAPTERS list (crawler/adapters/index.ts)
// so pickAdapter routes feed URLs to the right per-source extractor.
// Per-source adapters all share the same `_shared.buildDealAdapterResult`
// pipeline and differ only in (hosts, url_patterns, source_type tier).

import type { SiteAdapter } from "../types";
import { techcrunchFunding } from "./techcrunchFunding";
import { prNewswireFunding } from "./prNewswireFunding";
import { businessWireFunding } from "./businessWireFunding";
import { globeNewswireFunding } from "./globeNewswireFunding";
import { ventureBeatFunding } from "./ventureBeatFunding";
import { crunchbaseNews } from "./crunchbaseNews";
import { axiosProRata } from "./axiosProRata";

export const DEAL_FEED_ADAPTERS: SiteAdapter[] = [
  techcrunchFunding,
  prNewswireFunding,
  businessWireFunding,
  globeNewswireFunding,
  ventureBeatFunding,
  crunchbaseNews,
  axiosProRata,
];

export {
  techcrunchFunding,
  prNewswireFunding,
  businessWireFunding,
  globeNewswireFunding,
  ventureBeatFunding,
  crunchbaseNews,
  axiosProRata,
};
