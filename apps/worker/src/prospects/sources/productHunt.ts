// Product Hunt daily RSS feed — emits product_launch.
import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet, apexDomain } from "./_helpers";
import { compliantFetch } from "./_fetch";

const FEED = "https://www.producthunt.com/feed";

const mod: SourceModule = {
  slug: "product_hunt",
  label: "Product Hunt Daily",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://www.producthunt.com/feed",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const res = await compliantFetch(ctx.env, FEED, mod.slug, { accept: "application/rss+xml" });
    if (!res || !res.ok) return { events, cursor: ctx.cursor };
    const xml = res.body;
    const r2_key = await archiveRaw(ctx.env, "product_hunt", xml, "xml");
    const items = xml.split(/<item>/).slice(1);
    for (const block of items) {
      const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block)?.[1]?.trim();
      const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1]?.trim();
      const pub = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1]?.trim();
      const desc = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/.exec(block)?.[1]?.trim() ?? "";
      if (!title || !link || !pub) continue;
      const ts = Date.parse(pub);
      if (!Number.isFinite(ts) || ts <= since) continue;
      if (ts > newest) newest = ts;
      const linkMatch = /href=["']https?:\/\/([^"'/]+)/i.exec(desc);
      const domain = apexDomain(linkMatch?.[1]);
      events.push({
        kind: "product_launch",
        confidence: 0.7,
        payload: { title, ph_url: link },
        evidence_url: link,
        evidence_snippet: clipSnippet(title),
        r2_key,
        occurred_at: new Date(ts).toISOString(),
        account: domain ? { domain, name: domain } : { name: title.split(" - ")[0] },
      });
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
