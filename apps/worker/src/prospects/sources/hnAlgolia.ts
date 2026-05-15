// Hacker News Algolia API. Catches "Who's Hiring" + Show HN + launch
// stories. Cursor stores the latest `created_at_i` seen.
// We emit:
//   - hiring_burst on monthly Who's Hiring threads when an account is
//     mentioned (text contains domain or company name);
//   - product_launch on Show HN posts that mention an account;
//   - press_mention for any other top-story mentions.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet, apexDomain } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface AlgoliaHit { objectID: string; created_at_i: number; created_at: string; story_text?: string; comment_text?: string; title?: string; url?: string; story_url?: string; story_title?: string }
interface AlgoliaResp { hits: AlgoliaHit[] }

const mod: SourceModule = {
  slug: "hn_algolia",
  label: "Hacker News (Algolia search)",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://hn.algolia.com/api",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Number(ctx.cursor) : Math.floor(Date.now() / 1000) - 6 * 3600;
    let newest = since;
    const events: SignalEventDraft[] = [];

    // Pull recent stories with hiring+launch keywords. Free tier permits
    // 10 000 req/h — we hit it ~once/h.
    const queries = [
      { tags: "story", query: "Show HN", kind: "product_launch" as const },
      { tags: "comment", query: "Who is hiring", kind: "hiring_role" as const },
    ];
    for (const q of queries) {
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=${encodeURIComponent(q.tags)}&query=${encodeURIComponent(q.query)}&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}&hitsPerPage=200`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/json" });
      if (!res || !res.ok) continue;
      let json: AlgoliaResp = { hits: [] };
      try { json = JSON.parse(res.body) as AlgoliaResp; } catch { continue; }
      const r2_key = await archiveRaw(ctx.env, "hn_algolia", res.body, "json");
      for (const h of json.hits) {
        if (h.created_at_i > newest) newest = h.created_at_i;
        const txt = (h.story_text || h.comment_text || h.title || "").trim();
        if (!txt) continue;
        // Resolve via URL host if present, else fall back to scanning
        // text for a known domain — only emit when the URL is something
        // we can attribute to an account.
        const link = h.url || h.story_url || `https://news.ycombinator.com/item?id=${h.objectID}`;
        const linkHost = (() => { try { return new URL(link).hostname; } catch { return null; } })();
        const domain = apexDomain(linkHost);
        if (!domain || domain === "ycombinator.com" || domain === "github.com") continue;
        events.push({
          kind: q.kind,
          confidence: 0.6,
          payload: { hn_id: h.objectID, title: h.title || h.story_title, query: q.query },
          evidence_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          evidence_snippet: clipSnippet(txt),
          r2_key,
          occurred_at: h.created_at,
          account: { domain, name: domain },
        });
      }
    }
    return { events, cursor: newest > since ? String(newest) : ctx.cursor };
  },
};

export default mod;
