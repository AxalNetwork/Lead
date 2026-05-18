// Task #5: deprecated. The Brave-snippet-only LinkedIn Jobs source was
// removed when paid third-party APIs were ripped out. The greenhouse /
// lever / ashby / workable / recruitee / personio / smartrecruiters
// adapters continue to surface hiring_role + hiring_burst signals via
// the in-house fetcher. The module is kept (returning an empty crawl)
// so persisted SCRAPE_CACHE cursors and any external references to the
// slug don't break.
import type { SourceModule, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "linkedin_jobs_brave",
  label: "LinkedIn Jobs (deprecated)",
  schedule: "every6h",
  enabledByDefault: false,
  docsUrl: "https://aidatasignal.com/ops/sources/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    return { events: [], cursor: null };
  },
};

export default mod;
