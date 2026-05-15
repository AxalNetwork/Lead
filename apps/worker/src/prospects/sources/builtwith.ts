// BuiltWith API — paid; requires env.BUILTWITH_API_KEY (not yet wired).
// Skeleton: emits no events without a key. When configured, the consumer
// would call https://api.builtwith.com/v21/api.json?KEY=…&LOOKUP={domain}
// per account and write tech_install signals + account_tech rows.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "builtwith",
  label: "BuiltWith Tech Stack",
  schedule: "daily",
  enabledByDefault: false,
  docsUrl: "https://api.builtwith.com/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
