// Capterra reviews — same Brave-snippet-only approach as the G2 module.
// Brave returns the SERP metadata we surface; we never fetch capterra.com
// directly.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, braveSearch, clipSnippet } from "./_helpers";

interface AccountRow { id: string; domain: string | null; name: string }

const COMPARE_HINT = /\b(vs\.?|versus|compare|alternatives?|comparison)\b/i;

const mod: SourceModule = {
  slug: "capterra",
  label: "Capterra Reviews (Brave snippets)",
  schedule: "daily",
  enabledByDefault: true,
  bravePoweredOnly: true,
  requiresEnv: "BRAVE_API_KEY",
  docsUrl: "https://www.capterra.com/",
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
      const q = `site:capterra.com "${r.name}" reviews`;
      const hits = await braveSearch(ctx.env, q, 10);
      if (!hits.length) continue;
      await archiveRaw(ctx.env, "capterra", JSON.stringify({ q, hits }), "json");
      for (const h of hits) {
        if (!/capterra\.com\//.test(h.url)) continue;
        // Skip undated SERP hits — see comment in g2.ts.
        if (!h.pageAge) continue;
        const ts = Date.parse(h.pageAge);
        if (!Number.isFinite(ts) || ts <= since) continue;
        if (ts > newest) newest = ts;
        const isCompare = COMPARE_HINT.test(`${h.title} ${h.description} ${h.url}`);
        events.push({
          kind: isCompare ? "review_compare" : "review_posted",
          confidence: 0.5,
          payload: { source: "capterra_brave", query: r.name, title: h.title, description: h.description },
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
