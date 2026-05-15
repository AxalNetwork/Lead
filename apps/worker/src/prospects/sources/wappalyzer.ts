// Wappalyzer — open-source ruleset; the SaaS tier is paid. Skeleton;
// the planned implementation runs the OSS ruleset against archived HTML
// in RAW_HTML on a sampled cadence and emits tech_install signals.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "wappalyzer",
  label: "Wappalyzer Detection",
  schedule: "daily",
  enabledByDefault: false,
  docsUrl: "https://www.wappalyzer.com/api/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
