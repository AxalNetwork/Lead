// Google News RSS (free, ToS allows feed consumption). Per-account query
// keyed off accounts.domain. We emit a press_mention for every fresh
// article. Caps at 25 accounts per pass to stay under cron budget.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface AccountRow { id: string; domain: string | null; name: string }

const mod: SourceModule = {
  slug: "google_news",
  label: "Google News (RSS)",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://news.google.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : Date.now() - 6 * 3600 * 1000;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, name FROM accounts WHERE id = ?`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, name FROM accounts
            WHERE status NOT IN ('lost','disqualified')
              AND domain IS NOT NULL
            ORDER BY account_score DESC
            LIMIT 25`,
        ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      const q = encodeURIComponent(`"${r.name}"`);
      const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/rss+xml" });
      if (!res || !res.ok) continue;
      const xml = res.body;
      const r2_key = await archiveRaw(ctx.env, "google_news", xml, "xml");
      const items = xml.split(/<item>/).slice(1);
      for (const block of items.slice(0, 20)) {
        const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block)?.[1]?.trim();
        const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1]?.trim();
        const pub = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1]?.trim();
        if (!title || !link || !pub) continue;
        const ts = Date.parse(pub);
        if (!Number.isFinite(ts) || ts <= since) continue;
        if (ts > newest) newest = ts;
        events.push({
          kind: "press_mention",
          confidence: 0.5,
          payload: { title, query: r.name },
          evidence_url: link,
          evidence_snippet: clipSnippet(title),
          r2_key,
          occurred_at: new Date(ts).toISOString(),
          account: { domain: r.domain ?? undefined, name: r.name },
        });
      }
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
