// SmartRecruiters public postings:
// https://api.smartrecruiters.com/v1/companies/{slug}/postings
// Seeded by accounts.meta_json.smartrecruiters_company.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface SrLocation { city?: string; country?: string; region?: string }
interface SrPosting {
  id?: string;
  name?: string;
  uuid?: string;
  ref?: string;
  releasedDate?: string;
  createdOn?: string;
  department?: { label?: string };
  location?: SrLocation;
  company?: { name?: string };
}
interface SrResp { content?: SrPosting[] }
interface AccountRow { id: string; domain: string | null; meta_json: string | null; name: string }

const mod: SourceModule = {
  slug: "smartrecruiters",
  label: "SmartRecruiters Postings",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://developers.smartrecruiters.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(
          `SELECT id, domain, meta_json, name FROM accounts WHERE id = ? AND meta_json LIKE '%smartrecruiters_company%'`,
        ).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, meta_json, name FROM accounts WHERE meta_json LIKE '%smartrecruiters_company%' LIMIT 100`,
        ).all<AccountRow>();
    let seeded = 0, boardsFetched = 0;
    for (const r of rows.results ?? []) {
      let slug = "";
      try { slug = String((JSON.parse(r.meta_json ?? "{}") as Record<string, unknown>).smartrecruiters_company ?? ""); } catch { /* skip */ }
      if (!slug) continue;
      seeded += 1;
      const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/json" });
      if (!res || !res.ok) continue;
      boardsFetched += 1;
      let parsed: SrResp = {};
      try { parsed = JSON.parse(res.body) as SrResp; } catch { continue; }
      const r2_key = await archiveRaw(ctx.env, "smartrecruiters", res.body, "json");
      const fresh = (parsed.content ?? []).filter((p) => {
        const ts = Date.parse(p.releasedDate ?? p.createdOn ?? "");
        return Number.isFinite(ts) && ts > since;
      });
      const burst = fresh.length >= 5;
      for (const p of fresh) {
        const stamp = p.releasedDate ?? p.createdOn!;
        const ts = Date.parse(stamp);
        if (ts > newest) newest = ts;
        events.push({
          kind: burst ? "hiring_burst" : "hiring_role",
          confidence: 0.9,
          payload: { id: p.id ?? p.uuid, title: p.name, department: p.department?.label, location: p.location, company: slug },
          evidence_url: `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(p.id ?? p.uuid ?? "")}`,
          evidence_snippet: clipSnippet(`${p.name ?? ""} — ${p.department?.label ?? ""}`),
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
      // all. `smartrecruiters_company` is operator-seeded on accounts.meta_json and
      // nothing sets it automatically, so seeded_accounts: 0 is the normal
      // state today — and the state an operator has no other way to see.
      meta: { seeded_accounts: seeded, boards_fetched: boardsFetched },
    };
  },
};

export default mod;
