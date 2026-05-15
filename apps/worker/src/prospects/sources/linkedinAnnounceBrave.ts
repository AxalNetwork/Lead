// LinkedIn company announcements — same Brave-cache-only constraint.
// Skeleton; production impl emits leadership_change / partnership_announce
// from `site:linkedin.com/posts` snippets containing role-change keywords.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "linkedin_announce_brave",
  label: "LinkedIn Announcements (Brave cache)",
  schedule: "every6h",
  enabledByDefault: false,
  bravePoweredOnly: true,
  requiresEnv: "BRAVE_API_KEY",
  docsUrl: "https://api.search.brave.com/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
