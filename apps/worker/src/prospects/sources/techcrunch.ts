// TechCrunch RSS — funding coverage + product launches.
import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet, apexDomain } from "./_helpers";

const FEED = "https://techcrunch.com/feed/";

const mod: SourceModule = {
  slug: "techcrunch",
  label: "TechCrunch RSS",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://techcrunch.com/feed/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const res = await fetch(FEED, { headers: { Accept: "application/rss+xml" } });
    if (!res.ok) return { events, cursor: ctx.cursor };
    const xml = await res.text();
    const r2_key = await archiveRaw(ctx.env, "techcrunch", xml, "xml");
    const items = xml.split(/<item>/).slice(1);
    for (const block of items) {
      const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1]?.trim();
      const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block)?.[1]?.trim();
      const pub = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1]?.trim();
      if (!link || !title || !pub) continue;
      const ts = Date.parse(pub);
      if (!Number.isFinite(ts) || ts <= since) continue;
      if (ts > newest) newest = ts;
      // Best-effort domain extraction — TC articles often link out in
      // the body, but parsing that requires a second fetch. Skip if
      // we can't infer one from the slug.
      const slug = /techcrunch\.com\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\//.exec(link)?.[1];
      if (!slug) continue;
      const domain = apexDomain(slug.split("-").slice(0, 2).join("") + ".com");
      void domain; // resolution falls through to fuzzy name match
      const isFunding = /\braises\b|\bseries\s+[a-d]\b|\bfund(?:ed|ing)\b|\bbacked\b/i.test(title);
      events.push({
        kind: isFunding ? "funding_round" : "press_mention",
        confidence: 0.55,
        payload: { title, slug },
        evidence_url: link,
        evidence_snippet: clipSnippet(title),
        r2_key,
        occurred_at: new Date(ts).toISOString(),
        // Resolution falls back to fuzzy name; the resolver returns null
        // when it can't, and the caller skips persistence.
        account: { name: title.replace(/\s+raises?\s.*/i, "").trim().slice(0, 80) },
      });
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
