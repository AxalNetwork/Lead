// Crunchbase News RSS (free) — funding announcements, launch coverage.
// Emits funding_round / press_mention against the linked company.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet, apexDomain } from "./_helpers";
import { compliantFetch } from "./_fetch";

const FEED = "https://news.crunchbase.com/feed/";

interface RssItem { title: string; link: string; pubDate: string; description: string }

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const get = (tag: string) => {
      const r = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return (r?.[1] ?? r?.[2] ?? "").trim();
    };
    items.push({ title: get("title"), link: get("link"), pubDate: get("pubDate"), description: get("description") });
  }
  return items;
}

const mod: SourceModule = {
  slug: "crunchbase_news",
  label: "Crunchbase News (RSS)",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://news.crunchbase.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    const events: SignalEventDraft[] = [];
    let newest = since;
    const res = await compliantFetch(ctx.env, FEED, mod.slug, { accept: "application/rss+xml" });
    if (!res || !res.ok) return { events, cursor: ctx.cursor };
    const xml = res.body;
    const r2_key = await archiveRaw(ctx.env, "crunchbase_news", xml, "xml");
    for (const it of parseRss(xml)) {
      const ts = Date.parse(it.pubDate);
      if (!Number.isFinite(ts) || ts <= since) continue;
      if (ts > newest) newest = ts;
      // Best-effort: pick first external link from the description as the
      // company URL when present, otherwise skip resolution.
      const linkMatch = /href=["']https?:\/\/([^"'/]+)/i.exec(it.description);
      const domain = apexDomain(linkMatch?.[1]);
      if (!domain) continue;
      const isFunding = /raises|funding|seed|series\s+[a-d]|round/i.test(it.title);
      events.push({
        kind: isFunding ? "funding_round" : "press_mention",
        confidence: isFunding ? 0.85 : 0.7,
        payload: { title: it.title },
        evidence_url: it.link,
        evidence_snippet: clipSnippet(it.title),
        r2_key,
        occurred_at: new Date(ts).toISOString(),
        account: { domain, name: domain },
      });
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
