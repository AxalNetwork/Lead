// Personio public XML feed: https://{company}.jobs.personio.de/xml
// Seeded by accounts.meta_json.personio_company. Personio's feed gives a
// per-position `createdAt` we use for the per-account cursor (epoch ms).

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface AccountRow { id: string; domain: string | null; meta_json: string | null; name: string }

function unwrap(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

interface ParsedPosition { id: string; name: string; department?: string; office?: string; createdAt?: string; recruitingCategory?: string }

function parsePositions(xml: string): ParsedPosition[] {
  const out: ParsedPosition[] = [];
  const re = /<position>([\s\S]*?)<\/position>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const get = (tag: string) => unwrap((new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block)?.[1] ?? ""));
    const id = get("id") || get("subcompany");
    const name = get("name");
    if (!name) continue;
    out.push({
      id,
      name,
      department: get("department") || undefined,
      office: get("office") || undefined,
      createdAt: get("createdAt") || undefined,
      recruitingCategory: get("recruitingCategory") || undefined,
    });
  }
  return out;
}

const mod: SourceModule = {
  slug: "personio",
  label: "Personio Jobs XML",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://developer.personio.de/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(
          `SELECT id, domain, meta_json, name FROM accounts WHERE id = ? AND meta_json LIKE '%personio_company%'`,
        ).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, meta_json, name FROM accounts WHERE meta_json LIKE '%personio_company%' LIMIT 100`,
        ).all<AccountRow>();
    let seeded = 0, boardsFetched = 0;
    for (const r of rows.results ?? []) {
      let company = "";
      try { company = String((JSON.parse(r.meta_json ?? "{}") as Record<string, unknown>).personio_company ?? ""); } catch { /* skip */ }
      if (!company) continue;
      seeded += 1;
      const url = `https://${encodeURIComponent(company)}.jobs.personio.de/xml`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/xml" });
      if (!res || !res.ok) continue;
      boardsFetched += 1;
      const r2_key = await archiveRaw(ctx.env, "personio", res.body, "xml");
      const positions = parsePositions(res.body);
      const fresh = positions.filter((p) => {
        const ts = Date.parse(p.createdAt ?? "");
        return Number.isFinite(ts) && ts > since;
      });
      const burst = fresh.length >= 5;
      for (const p of fresh) {
        const ts = Date.parse(p.createdAt!);
        if (ts > newest) newest = ts;
        events.push({
          kind: burst ? "hiring_burst" : "hiring_role",
          confidence: 0.9,
          payload: { id: p.id, title: p.name, department: p.department, office: p.office, category: p.recruitingCategory, company },
          evidence_url: `https://${company}.jobs.personio.de/job/${encodeURIComponent(p.id)}`,
          evidence_snippet: clipSnippet(`${p.name} — ${p.department ?? ""}`),
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
      // all. `personio_company` is operator-seeded on accounts.meta_json and
      // nothing sets it automatically, so seeded_accounts: 0 is the normal
      // state today — and the state an operator has no other way to see.
      meta: { seeded_accounts: seeded, boards_fetched: boardsFetched },
    };
  },
};

export default mod;
