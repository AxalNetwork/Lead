// Workable public widget feed: https://apply.workable.com/api/v3/accounts/{slug}/jobs
// Seeded by accounts.meta_json.workable_account. Cursor stores the latest
// `published_on` ISO across all boards.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface WkJob {
  shortcode?: string;
  title?: string;
  url?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  department?: string;
  location?: { city?: string; country?: string };
  state?: string;
}
interface WkResp { jobs?: WkJob[] }
interface AccountRow { id: string; domain: string | null; meta_json: string | null; name: string }

const mod: SourceModule = {
  slug: "workable",
  label: "Workable Widget Feed",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://workable.readme.io/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(
          `SELECT id, domain, meta_json, name FROM accounts WHERE id = ? AND meta_json LIKE '%workable_account%'`,
        ).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, meta_json, name FROM accounts WHERE meta_json LIKE '%workable_account%' LIMIT 100`,
        ).all<AccountRow>();
    let seeded = 0, boardsFetched = 0;
    for (const r of rows.results ?? []) {
      let slug = "";
      try { slug = String((JSON.parse(r.meta_json ?? "{}") as Record<string, unknown>).workable_account ?? ""); } catch { /* skip */ }
      if (!slug) continue;
      seeded += 1;
      const url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/json" });
      if (!res || !res.ok) continue;
      boardsFetched += 1;
      let parsed: WkResp = {};
      try { parsed = JSON.parse(res.body) as WkResp; } catch { continue; }
      const r2_key = await archiveRaw(ctx.env, "workable", res.body, "json");
      const fresh = (parsed.jobs ?? []).filter((j) => {
        const ts = Date.parse(j.published_on ?? j.created_at ?? "");
        return Number.isFinite(ts) && ts > since && (j.state ?? "published") !== "closed";
      });
      const burst = fresh.length >= 5;
      for (const j of fresh) {
        const stamp = j.published_on ?? j.created_at!;
        const ts = Date.parse(stamp);
        if (ts > newest) newest = ts;
        events.push({
          kind: burst ? "hiring_burst" : "hiring_role",
          confidence: 0.9,
          payload: { shortcode: j.shortcode, title: j.title, department: j.department, location: j.location, account: slug },
          evidence_url: j.url ?? j.application_url,
          evidence_snippet: clipSnippet(`${j.title ?? ""} — ${j.department ?? ""}`),
          r2_key,
          occurred_at: new Date(ts).toISOString(),
          account: { domain: r.domain ?? undefined, name: r.name },
        });
      }
    }
    return {
      events,
      cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor,
      // Without this the run records `0 events, ok` whether it scanned a
      // hundred boards and found nothing new or found nothing to scan at
      // all. `workable_account` is operator-seeded on accounts.meta_json and
      // nothing sets it automatically, so seeded_accounts: 0 is the normal
      // state today — and the state an operator has no other way to see.
      meta: { seeded_accounts: seeded, boards_fetched: boardsFetched },
    };
  },
};

export default mod;
