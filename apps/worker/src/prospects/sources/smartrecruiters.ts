// SmartRecruiters public postings:
// https://api.smartrecruiters.com/v1/companies/{slug}/postings
// Skeleton; emits no events until accounts.meta_json.smartrecruiters_company is set.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "smartrecruiters",
  label: "SmartRecruiters Postings",
  schedule: "hourly",
  enabledByDefault: false,
  docsUrl: "https://developers.smartrecruiters.com/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
