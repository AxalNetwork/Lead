// Recruitee public careers JSON: https://{company}.recruitee.com/api/offers/
// Seeded by accounts.meta_json.recruitee_company. Cursor stores latest
// `created_at` (ISO) across boards.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface RtOffer {
  id?: number;
  title?: string;
  careers_url?: string;
  careers_apply_url?: string;
  created_at?: string;
  published_at?: string;
  department?: string;
  city?: string;
  country?: string;
  status?: string;
}
interface RtResp { offers?: RtOffer[] }
interface AccountRow { id: string; domain: string | null; meta_json: string | null; name: string }

const mod: SourceModule = {
  slug: "recruitee",
  label: "Recruitee Careers",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://docs.recruitee.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(
          `SELECT id, domain, meta_json, name FROM accounts WHERE id = ? AND meta_json LIKE '%recruitee_company%'`,
        ).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, meta_json, name FROM accounts WHERE meta_json LIKE '%recruitee_company%' LIMIT 100`,
        ).all<AccountRow>();
    let seeded = 0, boardsFetched = 0;
    for (const r of rows.results ?? []) {
      let company = "";
      try { company = String((JSON.parse(r.meta_json ?? "{}") as Record<string, unknown>).recruitee_company ?? ""); } catch { /* skip */ }
      if (!company) continue;
      seeded += 1;
      const url = `https://${encodeURIComponent(company)}.recruitee.com/api/offers/`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/json" });
      if (!res || !res.ok) continue;
      boardsFetched += 1;
      let parsed: RtResp = {};
      try { parsed = JSON.parse(res.body) as RtResp; } catch { continue; }
      const r2_key = await archiveRaw(ctx.env, "recruitee", res.body, "json");
      const fresh = (parsed.offers ?? []).filter((o) => {
        const stamp = o.published_at ?? o.created_at ?? "";
        const ts = Date.parse(stamp);
        return Number.isFinite(ts) && ts > since && (o.status ?? "published") === "published";
      });
      const burst = fresh.length >= 5;
      for (const o of fresh) {
        const stamp = o.published_at ?? o.created_at!;
        const ts = Date.parse(stamp);
        if (ts > newest) newest = ts;
        events.push({
          kind: burst ? "hiring_burst" : "hiring_role",
          confidence: 0.9,
          payload: { id: o.id, title: o.title, department: o.department, city: o.city, country: o.country, company },
          evidence_url: o.careers_url ?? o.careers_apply_url,
          evidence_snippet: clipSnippet(`${o.title ?? ""} — ${o.department ?? ""}`),
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
      // all. `recruitee_company` is operator-seeded on accounts.meta_json and
      // nothing sets it automatically, so seeded_accounts: 0 is the normal
      // state today — and the state an operator has no other way to see.
      meta: { seeded_accounts: seeded, boards_fetched: boardsFetched },
    };
  },
};

export default mod;
