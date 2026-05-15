// GDELT 2.0 DOC API — global news + event corpus. Skeleton; planned
// implementation calls https://api.gdeltproject.org/api/v2/doc/doc?query=…
// with per-account name queries and emits press_mention.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "gdelt",
  label: "GDELT 2.0 News",
  schedule: "every6h",
  enabledByDefault: false,
  docsUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
