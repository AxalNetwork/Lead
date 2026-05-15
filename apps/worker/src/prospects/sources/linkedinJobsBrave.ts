// LinkedIn jobs — never fetched directly per LinkedIn ToS. Skeleton
// reserves the slot; production impl reads Brave Search cache snippets
// (see scraper/fetchers/brave.fetchBraveCache) for `site:linkedin.com/jobs`
// queries and emits hiring_role events.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "linkedin_jobs_brave",
  label: "LinkedIn Jobs (Brave cache)",
  schedule: "every6h",
  enabledByDefault: false,
  bravePoweredOnly: true,
  requiresEnv: "BRAVE_API_KEY",
  docsUrl: "https://api.search.brave.com/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
