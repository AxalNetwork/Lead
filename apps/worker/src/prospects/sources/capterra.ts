// Task #5: in-house Capterra source. Same approach as g2.ts — walk the
// public per-product reviews page via the in-house fetcher and emit a
// review_posted signal when a fresh review timestamp appears.
import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { fetchPage } from "../../scraper/fetcher";

interface AccountRow { id: string; domain: string | null; name: string }

const COMPARE_HINT = /\b(vs\.?|versus|compare|alternatives?|comparison)\b/i;
const REVIEW_TS_RE = /(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const mod: SourceModule = {
  slug: "capterra",
  label: "Capterra Reviews (in-house crawler)",
  schedule: "daily",
  enabledByDefault: true,
  docsUrl: "https://aidatasignal.com/ops/sources/",
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
      const slug = slugify(r.name);
      if (!slug) continue;
      const url = `https://www.capterra.com/p/${slug}/reviews/`;
      const fetched = await fetchPage(ctx.env, url, { minIntervalMs: 6000 });
      if (!fetched.ok || !fetched.html) continue;
      const r2_key = await archiveRaw(ctx.env, "capterra", fetched.html, "html");
      const tsMatch = REVIEW_TS_RE.exec(fetched.html);
      if (!tsMatch) continue;
      const ts = Date.parse(tsMatch[1] + "T00:00:00Z");
      if (!Number.isFinite(ts) || ts <= since) continue;
      if (ts > newest) newest = ts;
      const snippet = clipSnippet(fetched.html.replace(/<[^>]+>/g, " ").slice(0, 600));
      const isCompare = COMPARE_HINT.test(`${snippet} ${url}`);
      events.push({
        kind: isCompare ? "review_compare" : "review_posted",
        confidence: 0.55,
        payload: { source: "capterra_inhouse", slug, account_id: r.id, fetched_tier: fetched.tier },
        evidence_url: url,
        evidence_snippet: snippet,
        r2_key,
        occurred_at: new Date(ts).toISOString(),
        account: { domain: r.domain ?? undefined, name: r.name },
      });
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
