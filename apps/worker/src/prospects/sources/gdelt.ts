// GDELT 2.0 DOC API — global news + event corpus (free, attribution).
// Per-account exact-name query, returns fresh articles as press_mention
// signals. Caps at 25 accounts per pass to stay inside the cron budget.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface GdeltArticle { url?: string; url_mobile?: string; title?: string; seendate?: string; domain?: string; language?: string; sourcecountry?: string }
interface GdeltResp { articles?: GdeltArticle[] }
interface AccountRow { id: string; domain: string | null; name: string }

// GDELT uses "YYYYMMDDHHMMSS" UTC.
function parseGdeltDate(s: string | undefined): number {
  if (!s || s.length < 14) return NaN;
  const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
  const h = s.slice(8, 10), mi = s.slice(10, 12), se = s.slice(12, 14);
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
}

const mod: SourceModule = {
  slug: "gdelt",
  label: "GDELT 2.0 News",
  schedule: "every6h",
  enabledByDefault: true,
  docsUrl: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : Date.now() - 24 * 3600 * 1000;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, name FROM accounts WHERE id = ?`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, name FROM accounts
            WHERE status NOT IN ('lost','disqualified')
              AND name IS NOT NULL
            ORDER BY account_score DESC
            LIMIT 25`,
        ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      if (!r.name) continue;
      const q = `"${r.name.replace(/"/g, " ")}"`;
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&format=json&maxrecords=15&sort=DateDesc`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/json" });
      if (!res || !res.ok) continue;
      let parsed: GdeltResp = {};
      try { parsed = JSON.parse(res.body) as GdeltResp; } catch { continue; }
      const r2_key = await archiveRaw(ctx.env, "gdelt", res.body, "json");
      for (const a of parsed.articles ?? []) {
        const ts = parseGdeltDate(a.seendate);
        if (!Number.isFinite(ts) || ts <= since) continue;
        if (ts > newest) newest = ts;
        const link = a.url ?? a.url_mobile;
        if (!link || !a.title) continue;
        events.push({
          kind: "press_mention",
          confidence: 0.55,
          payload: { source: "gdelt", title: a.title, domain: a.domain, language: a.language, country: a.sourcecountry, query: r.name },
          evidence_url: link,
          evidence_snippet: clipSnippet(a.title),
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
