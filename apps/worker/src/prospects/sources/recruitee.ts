// Recruitee public careers JSON: https://{company}.recruitee.com/api/offers/
// Skeleton; emits no events until a board allowlist is seeded under
// accounts.meta_json.recruitee_company.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "recruitee",
  label: "Recruitee Careers",
  schedule: "hourly",
  enabledByDefault: false,
  docsUrl: "https://docs.recruitee.com/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
