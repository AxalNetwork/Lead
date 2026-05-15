// LinkedIn Jobs — fetched ONLY via Brave Search snippets per LinkedIn ToS.
// We never request linkedin.com/jobs directly. Each Brave hit becomes a
// hiring_role signal; the cluster threshold from the deterministic ATS
// modules (>= 5 fresh per account in one pass) upgrades to hiring_burst.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, braveSearch, clipSnippet } from "./_helpers";

interface AccountRow { id: string; domain: string | null; name: string }

const mod: SourceModule = {
  slug: "linkedin_jobs_brave",
  label: "LinkedIn Jobs (Brave cache)",
  schedule: "every6h",
  enabledByDefault: true,
  bravePoweredOnly: true,
  requiresEnv: "BRAVE_API_KEY",
  docsUrl: "https://api.search.brave.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : Date.now() - 7 * 86400 * 1000;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, name FROM accounts WHERE id = ?`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, name FROM accounts
            WHERE status NOT IN ('lost','disqualified') AND name IS NOT NULL
            ORDER BY account_score DESC LIMIT 25`,
        ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      if (!r.name) continue;
      const q = `site:linkedin.com/jobs "${r.name}"`;
      const hits = await braveSearch(ctx.env, q, 15);
      if (!hits.length) continue;
      await archiveRaw(ctx.env, "linkedin_jobs_brave", JSON.stringify({ q, hits }), "json");
      // Brave returns page_age for LinkedIn jobs hits; undated SERP rows
      // are dropped to avoid re-emitting the same posting on every run.
      const fresh = hits.filter((h) => {
        if (!/linkedin\.com\/jobs\//i.test(h.url) || !h.pageAge) return false;
        const ts = Date.parse(h.pageAge);
        return Number.isFinite(ts) && ts > since;
      });
      const burst = fresh.length >= 5;
      for (const h of fresh) {
        const ts = Date.parse(h.pageAge!);
        if (ts > newest) newest = ts;
        events.push({
          kind: burst ? "hiring_burst" : "hiring_role",
          confidence: 0.5,
          payload: { source: "linkedin_brave", query: r.name, title: h.title, description: h.description },
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
