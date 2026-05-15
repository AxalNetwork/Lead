// G2 reviews — ToS-restricted; only via the official G2 API (paid) or
// public review aggregator pages routed through Brave Search cache.
// Skeleton until G2 API key is wired in env.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "g2",
  label: "G2 Reviews",
  schedule: "daily",
  enabledByDefault: false,
  docsUrl: "https://documentation.g2.com/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
