// G2 reviews — ToS forbids direct scraping. We use Brave Search snippet
// metadata only (URL + title + description), which is what Brave's API
// permits us to surface. Each fresh review-page hit becomes a
// review_posted signal; pages whose snippet mentions a competitor name
// are upgraded to review_compare.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, braveSearch, clipSnippet } from "./_helpers";

interface AccountRow { id: string; domain: string | null; name: string }

const COMPARE_HINT = /\b(vs\.?|versus|compare|alternatives?|comparison)\b/i;

const mod: SourceModule = {
  slug: "g2",
  label: "G2 Reviews (Brave snippets)",
  schedule: "daily",
  enabledByDefault: true,
  bravePoweredOnly: true,
  requiresEnv: "BRAVE_API_KEY",
  docsUrl: "https://documentation.g2.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : Date.now() - 7 * 86400 * 1000;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, name FROM accounts WHERE id = ?`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, name FROM accounts
            WHERE status NOT IN ('lost','disqualified') AND name IS NOT NULL
            ORDER BY account_score DESC LIMIT 20`,
        ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      if (!r.name) continue;
      const q = `site:g2.com "${r.name}" reviews`;
      const hits = await braveSearch(ctx.env, q, 10);
      if (!hits.length) continue;
      await archiveRaw(ctx.env, "g2", JSON.stringify({ q, hits }), "json");
      for (const h of hits) {
        if (!/g2\.com\//.test(h.url)) continue;
        // Skip undated SERP hits: without page_age we'd re-emit the same
        // hit on every run with a moving occurred_at. Brave returns
        // page_age for the vast majority of review pages.
        if (!h.pageAge) continue;
        const ts = Date.parse(h.pageAge);
        if (!Number.isFinite(ts) || ts <= since) continue;
        if (ts > newest) newest = ts;
        const isCompare = COMPARE_HINT.test(`${h.title} ${h.description} ${h.url}`);
        events.push({
          kind: isCompare ? "review_compare" : "review_posted",
          confidence: 0.55,
          payload: { source: "g2_brave", query: r.name, title: h.title, description: h.description },
          evidence_url: h.url,
          evidence_snippet: clipSnippet(`${h.title} — ${h.description}`),
          occurred_at: new Date(ts).toISOString(),
          account: { domain: r.domain ?? undefined, name: r.name },
        });
      }
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
