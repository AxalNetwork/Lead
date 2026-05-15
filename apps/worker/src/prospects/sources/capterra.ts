// Capterra reviews — same caveats as G2; awaiting partner API.
import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "capterra",
  label: "Capterra Reviews",
  schedule: "daily",
  enabledByDefault: false,
  docsUrl: "https://www.capterra.com/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
