// Task #5: deprecated. See linkedinJobsBrave.ts for context. The
// leadership_change / partnership_announce / product_launch signals
// previously surfaced from Brave snippets are now produced by the
// hnAlgolia / techcrunch / googleNews / productHunt / crunchbaseNews
// in-house adapters.
import type { SourceModule, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "linkedin_announce_brave",
  label: "LinkedIn Announcements (deprecated)",
  schedule: "every6h",
  enabledByDefault: false,
  docsUrl: "https://aidatasignal.com/ops/sources/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    return { events: [], cursor: null };
  },
};

export default mod;
