// Lever public postings API: https://api.lever.co/v0/postings/{company}
// Same shape as Greenhouse — accounts.meta_json.lever_company seeds it.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";

interface Posting { id: string; text: string; createdAt: number; hostedUrl: string; categories?: { team?: string; location?: string; commitment?: string } }
interface AccountRow { id: string; domain: string | null; meta_json: string | null; name: string }

const mod: SourceModule = {
  slug: "lever",
  label: "Lever Postings API",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://github.com/lever/postings-api",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Number(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = await ctx.env.DB.prepare(
      `SELECT id, domain, meta_json, name FROM accounts WHERE meta_json LIKE '%lever_company%' LIMIT 100`,
    ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      let company = "";
      try { company = String((JSON.parse(r.meta_json ?? "{}") as Record<string, unknown>).lever_company ?? ""); } catch { /* skip */ }
      if (!company) continue;
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const raw = await res.text();
      let postings: Posting[] = [];
      try { postings = JSON.parse(raw) as Posting[]; } catch { continue; }
      const r2_key = await archiveRaw(ctx.env, "lever", raw, "json");
      const fresh = postings.filter((p) => p.createdAt > since);
      const burst = fresh.length >= 5;
      for (const p of fresh) {
        if (p.createdAt > newest) newest = p.createdAt;
        events.push({
          kind: burst ? "hiring_burst" : "hiring_role",
          confidence: 0.9,
          payload: { id: p.id, text: p.text, team: p.categories?.team, location: p.categories?.location, commitment: p.categories?.commitment, company },
          evidence_url: p.hostedUrl,
          evidence_snippet: clipSnippet(`${p.text} — ${p.categories?.team ?? ""}`),
          r2_key,
          occurred_at: new Date(p.createdAt).toISOString(),
          account: { domain: r.domain ?? undefined, name: r.name },
        });
      }
    }
    return { events, cursor: newest > since ? String(newest) : ctx.cursor };
  },
};

export default mod;
