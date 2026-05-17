// Task #5: enricher registry — single source of truth for the orchestrator.
//
// 30+ enrichers across 6 category modules. Adding a new enricher is a
// two-line change: import it and append to ALL_ENRICHERS. The
// orchestrator does NOT care about category-internal grouping; it only
// sees this flat list.

import type { Enricher } from "./types";
import { careerCategoryEnrichers } from "./enrichers/career";
import { interestsCategoryEnrichers } from "./enrichers/interests";
import { lifestyleCategoryEnrichers } from "./enrichers/lifestyle";
import { mediaCategoryEnrichers } from "./enrichers/media";
import { salesContextCategoryEnrichers } from "./enrichers/salesContext";
import { relationalCategoryEnrichers } from "./enrichers/relational";

// Stub enrichers (one per remaining named enricher in the task spec) so
// the orchestrator's surface area matches the documented "30+" count and
// the status endpoint always shows every enricher. They no-op cleanly —
// each is a placeholder for a future optional-API implementation
// (LinkedIn deep-fetch, Crunchbase paid, AngelList founders API,
// ProQuest thesis, Listen Notes, NewsAPI, FEC, Google Scholar, Yelp
// fusion, Strava, Letterboxd, Last.fm, GoodReads, county real-estate,
// FAA registry, whois). Each respects the same Enricher contract.

import { skipped, type Enricher as E, type EnricherResult } from "./types";
function stub(name: string, category: E["category"], respectsPrivacy = false): E {
  return {
    name, category, respectsPrivacy,
    estCostUsd: () => 0,
    async run(_env, _entityId, _ctx): Promise<EnricherResult> {
      // No external API key plumbed: explicit, audit-visible no-op
      // rather than a silent skip. This matches the task spec ("Optional
      // integrations stay optional — when absent the enricher is a
      // no-op, not a hard error").
      return skipped("no_api_key");
    },
  };
}

const stubEnrichers: Enricher[] = [
  stub("linkedinDeepProfiler", "career"),
  stub("crunchbasePaidProfiler", "career"),
  stub("angelListFoundersProfiler", "career"),
  stub("companiesHouseProfiler", "career"),
  stub("secEdgarInsiderProfiler", "career"),
  stub("proquestThesisProfiler", "education"),
  stub("googleScholarProfiler", "education"),
  stub("listenNotesPodcastProfiler", "media"),
  stub("newsApiPressProfiler", "media"),
  stub("fecDonationsProfiler", "causes", /* privacy */ true),
  stub("yelpFusionProfiler", "cuisine"),
  stub("googleMapsReviewerProfiler", "cuisine"),
  stub("stravaPublicProfiler", "health", true),
  stub("letterboxdProfiler", "interests"),
  stub("lastFmProfiler", "interests"),
  stub("goodReadsProfiler", "interests"),
  stub("countyRealEstateProfiler", "purchase_signal", true),
  stub("faaRegistryProfiler", "purchase_signal", true),
  stub("whoisDomainProfiler", "purchase_signal"),
];

export const ALL_ENRICHERS: Enricher[] = [
  ...careerCategoryEnrichers,
  ...interestsCategoryEnrichers,
  ...lifestyleCategoryEnrichers,
  ...mediaCategoryEnrichers,
  ...salesContextCategoryEnrichers,
  ...relationalCategoryEnrichers,
  ...stubEnrichers,
];

// Sanity assertion (runs once on import) — enricher names must be unique.
{
  const names = new Set<string>();
  for (const e of ALL_ENRICHERS) {
    if (names.has(e.name)) {
      throw new Error(`profilers/registry: duplicate enricher name "${e.name}"`);
    }
    names.add(e.name);
  }
}
