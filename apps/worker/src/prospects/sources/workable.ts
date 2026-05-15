// Workable public widget feed: https://apply.workable.com/api/v1/widget/accounts/{slug}
// Skeleton only — wire account meta_json.workable_account before enabling
// in production. Returns no events when account list is empty.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "workable",
  label: "Workable Widget Feed",
  schedule: "hourly",
  enabledByDefault: false,
  docsUrl: "https://workable.readme.io/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
