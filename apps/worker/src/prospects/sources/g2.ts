// Task #5: in-house G2 source. The previous implementation used the
// paid Brave Search API for SERP snippets. This rewrite walks G2's
// public per-product page through the in-house fetcher and records a
// review_posted signal whenever the page exposes a fresh
// "Latest review" timestamp. Each fetched HTML body is stashed in
// R2 (via archiveRaw) so the adapter can be re-run from a frozen
// snapshot during debugging.
//
// Resolution policy:
//   1. Account.domain ⇒ try https://www.g2.com/products/<apex>/reviews
//      (G2's slug convention is the apex without TLD, falling back to
//       a slugified name if the apex slug 404s).
//   2. Account.name ⇒ slugified fallback only.
//
// We bail out early on tier-2+ fetch failure to keep the per-tick
// budget bounded; the next nightly run will retry.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { fetchPage } from "../../scraper/fetcher";

interface AccountRow { id: string; domain: string | null; name: string }

const COMPARE_HINT = /\b(vs\.?|versus|compare|alternatives?|comparison)\b/i;
const REVIEW_TS_RE = /datetime="([^"]+)"[^>]*>\s*[A-Z][a-z]+\s+\d{1,2},\s*\d{4}/;
const REVIEW_BLOCK_RE = /<div[^>]+class="[^"]*review[^"]*"[^>]*>([\s\S]{0,400})/i;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function candidateSlugs(row: AccountRow): string[] {
  const slugs = new Set<string>();
  if (row.domain) {
    const apex = row.domain.replace(/^www\./, "").split(".")[0];
    if (apex) slugs.add(apex);
  }
  if (row.name) slugs.add(slugify(row.name));
  return [...slugs].filter(Boolean);
}

const mod: SourceModule = {
  slug: "g2",
  label: "G2 Reviews (in-house crawler)",
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
      for (const slug of candidateSlugs(r)) {
        const url = `https://www.g2.com/products/${slug}/reviews`;
        const fetched = await fetchPage(ctx.env, url, { minIntervalMs: 6000 });
        if (!fetched.ok || !fetched.html) continue;
        const r2_key = await archiveRaw(ctx.env, "g2", fetched.html, "html");
        const tsMatch = REVIEW_TS_RE.exec(fetched.html);
        if (!tsMatch) break;
        const ts = Date.parse(tsMatch[1]);
        if (!Number.isFinite(ts) || ts <= since) break;
        if (ts > newest) newest = ts;
        const block = REVIEW_BLOCK_RE.exec(fetched.html)?.[1] ?? "";
        const snippet = clipSnippet(block.replace(/<[^>]+>/g, " "));
        const isCompare = COMPARE_HINT.test(`${snippet} ${url}`);
        events.push({
          kind: isCompare ? "review_compare" : "review_posted",
          confidence: 0.6,
          payload: { source: "g2_inhouse", slug, account_id: r.id, fetched_tier: fetched.tier },
          evidence_url: url,
          evidence_snippet: snippet,
          r2_key,
          occurred_at: new Date(ts).toISOString(),
          account: { domain: r.domain ?? undefined, name: r.name },
        });
        break;
      }
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
