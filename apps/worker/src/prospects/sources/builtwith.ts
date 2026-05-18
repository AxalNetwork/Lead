// Task #5: deprecated. The paid BuiltWith v21 API was removed; vendor
// detection now flows through the dnsTech + wappalyzer modules (both
// already in MODULES) which inspect public DNS records and HTTP
// response headers via the in-house fetcher. The slug is preserved so
// any cursor row keyed on it can be cleaned up without an error.
import type { SourceModule, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "builtwith",
  label: "BuiltWith Tech Stack (deprecated)",
  schedule: "daily",
  enabledByDefault: false,
  docsUrl: "https://aidatasignal.com/ops/sources/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    return { events: [], cursor: null };
  },
};

export default mod;
