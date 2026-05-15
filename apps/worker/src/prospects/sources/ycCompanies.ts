// Y Combinator companies index (ycombinator.com/companies). The public
// JSON feed is rate-limited; this skeleton is wired but disabled by
// default until we add a respectful per-batch fetcher with cursoring.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "yc_companies",
  label: "Y Combinator Companies",
  schedule: "daily",
  enabledByDefault: false,
  docsUrl: "https://www.ycombinator.com/companies",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
