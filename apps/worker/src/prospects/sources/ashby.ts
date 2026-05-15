// Ashby public job-board JSON: https://jobs.ashbyhq.com/{company}.json
// (the same payload that powers their public board UI). Cursor stores
// the highest seen `publishedDate`.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface AshbyJob { id: string; title: string; publishedDate?: string; jobUrl: string; locationName?: string; departmentName?: string }
interface AshbyResp { jobs?: AshbyJob[] }
interface AccountRow { id: string; domain: string | null; meta_json: string | null; name: string }

const mod: SourceModule = {
  slug: "ashby",
  label: "Ashby Job Board",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://developers.ashbyhq.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = await ctx.env.DB.prepare(
      `SELECT id, domain, meta_json, name FROM accounts WHERE meta_json LIKE '%ashby_company%' LIMIT 100`,
    ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      let company = "";
      try { company = String((JSON.parse(r.meta_json ?? "{}") as Record<string, unknown>).ashby_company ?? ""); } catch { /* skip */ }
      if (!company) continue;
      const url = `https://jobs.ashbyhq.com/${encodeURIComponent(company)}.json`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/json" });
      if (!res || !res.ok) continue;
      let parsed: AshbyResp = {};
      try { parsed = JSON.parse(res.body) as AshbyResp; } catch { continue; }
      const r2_key = await archiveRaw(ctx.env, "ashby", res.body, "json");
      const fresh = (parsed.jobs ?? []).filter((j) => j.publishedDate && Date.parse(j.publishedDate) > since);
      const burst = fresh.length >= 5;
      for (const j of fresh) {
        const ts = Date.parse(j.publishedDate!);
        if (ts > newest) newest = ts;
        events.push({
          kind: burst ? "hiring_burst" : "hiring_role",
          confidence: 0.9,
          payload: { id: j.id, title: j.title, location: j.locationName, department: j.departmentName, company },
          evidence_url: j.jobUrl,
          evidence_snippet: clipSnippet(`${j.title} — ${j.departmentName ?? ""}`),
          r2_key,
          occurred_at: j.publishedDate,
          account: { domain: r.domain ?? undefined, name: r.name },
        });
      }
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
