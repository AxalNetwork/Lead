// SEC EDGAR Form D filings (private placement / fundraising notices).
// Free + license-friendly; uses User-Agent from env.SEC_EDGAR_UA.
// Skeleton — full implementation parses the daily Form D index, resolves
// CIK→domain via filer's website field on the index. Wire up before
// enabling in production.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "sec_form_d",
  label: "SEC Form D (EDGAR)",
  schedule: "daily",
  enabledByDefault: false,
  requiresEnv: "SEC_EDGAR_UA",
  docsUrl: "https://www.sec.gov/edgar/searchedgar/edgarfulltextsearch.html",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
