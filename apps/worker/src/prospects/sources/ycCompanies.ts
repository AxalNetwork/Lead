// Y Combinator Launches feed (https://www.ycombinator.com/launches/feed.xml).
// Each entry is a freshly launched YC-backed product — emitted as
// product_launch against the launching company. We resolve the account by
// scraping the first non-YC outbound link from the entry's HTML body
// (companies always link their site from the launch post).

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet, apexDomain } from "./_helpers";
import { compliantFetch } from "./_fetch";

const FEED = "https://www.ycombinator.com/launches/feed.xml";

interface AtomEntry { title: string; link: string; updated: string; summary: string }

function parseAtom(xml: string): AtomEntry[] {
  const out: AtomEntry[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const title = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block)?.[1]?.trim() ?? "";
    const link = /<link[^>]*href="([^"]+)"/.exec(block)?.[1] ?? "";
    const updated = /<updated>([\s\S]*?)<\/updated>/.exec(block)?.[1]?.trim() ?? "";
    const summary = /<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/.exec(block)?.[1]?.trim()
      ?? /<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/.exec(block)?.[1]?.trim()
      ?? "";
    if (title && link && updated) out.push({ title, link, updated, summary });
  }
  return out;
}

function pickCompanyDomain(html: string): string | undefined {
  const re = /href=["'](https?:\/\/[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const u = m[1];
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (host.endsWith("ycombinator.com")) continue;
    if (host.endsWith("ycdn.co")) continue;
    if (host.endsWith("twitter.com") || host.endsWith("x.com") || host.endsWith("linkedin.com")) continue;
    if (host.endsWith("github.com") || host.endsWith("youtube.com")) continue;
    return apexDomain(host);
  }
  return undefined;
}

const mod: SourceModule = {
  slug: "yc_companies",
  label: "Y Combinator Launches",
  schedule: "every6h",
  enabledByDefault: true,
  docsUrl: "https://www.ycombinator.com/launches",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const res = await compliantFetch(ctx.env, FEED, mod.slug, { accept: "application/atom+xml" });
    if (!res || !res.ok) return { events, cursor: ctx.cursor };
    const r2_key = await archiveRaw(ctx.env, "yc_companies", res.body, "xml");
    for (const e of parseAtom(res.body)) {
      const ts = Date.parse(e.updated);
      if (!Number.isFinite(ts) || ts <= since) continue;
      if (ts > newest) newest = ts;
      const domain = pickCompanyDomain(e.summary);
      const name = e.title.replace(/^Launch\s+(YC[^:]*:\s*)?/i, "").trim() || e.title;
      if (!domain && !name) continue;
      events.push({
        kind: "product_launch",
        confidence: 0.85,
        payload: { source: "yc_launches", title: e.title },
        evidence_url: e.link,
        evidence_snippet: clipSnippet(e.title),
        r2_key,
        occurred_at: new Date(ts).toISOString(),
        account: { domain, name },
      });
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
