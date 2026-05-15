// Personio public XML feed: https://{company}.jobs.personio.de/xml
// Skeleton; emits no events until accounts.meta_json.personio_company is set.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "personio",
  label: "Personio Jobs XML",
  schedule: "hourly",
  enabledByDefault: false,
  docsUrl: "https://developer.personio.de/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
