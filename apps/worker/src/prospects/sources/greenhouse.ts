// Greenhouse public job-board API. Free + ToS-friendly.
// Cursor encodes the last seen "{board_token}:{updated_at}" so re-runs
// only emit signals for new postings. Boards to scan come from the
// `accounts.meta_json.greenhouse_board` field; absent boards are skipped.

import type { Env } from "../../types";
import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface GhJob { id: number; title: string; updated_at: string; absolute_url: string; departments?: Array<{ name: string }>; offices?: Array<{ name: string; location?: string }>; }
interface GhResp { jobs?: GhJob[] }
interface AccountRow { id: string; domain: string | null; meta_json: string | null; name: string }

async function fetchBoard(env: Env, token: string): Promise<{ jobs: GhJob[]; raw: string } | null> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=false`;
  const r = await compliantFetch(env, url, "greenhouse", { accept: "application/json" });
  if (!r || !r.ok) return null;
  try { const j = JSON.parse(r.body) as GhResp; return { jobs: j.jobs ?? [], raw: r.body }; } catch { return null; }
}

const mod: SourceModule = {
  slug: "greenhouse",
  label: "Greenhouse Job Board API",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://developers.greenhouse.io/job-board.html",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    const events: SignalEventDraft[] = [];
    // Pull at most 100 boards per pass — keeps cron well under the 30s budget.
    const rows = await ctx.env.DB.prepare(
      `SELECT id, domain, meta_json, name FROM accounts
        WHERE meta_json LIKE '%greenhouse_board%'
        LIMIT 100`,
    ).all<AccountRow>();
    let newest = since;
    let seeded = 0, boardsFetched = 0;
    for (const r of rows.results ?? []) {
      let token = "";
      try { token = String((JSON.parse(r.meta_json ?? "{}") as Record<string, unknown>).greenhouse_board ?? ""); } catch { /* skip */ }
      if (!token) continue;
      seeded += 1;
      const fetched = await fetchBoard(ctx.env, token);
      if (!fetched) continue;
      boardsFetched += 1;
      const r2_key = await archiveRaw(ctx.env, "greenhouse", fetched.raw, "json");
      const fresh = fetched.jobs.filter((j) => Date.parse(j.updated_at) > since);
      // Cluster: >= 5 new postings inside this run = hiring_burst.
      const burst = fresh.length >= 5;
      for (const job of fresh) {
        const ts = Date.parse(job.updated_at);
        if (ts > newest) newest = ts;
        events.push({
          kind: burst ? "hiring_burst" : "hiring_role",
          confidence: 0.9,
          payload: { job_id: job.id, title: job.title, departments: job.departments?.map((d) => d.name) ?? [], offices: job.offices?.map((o) => o.location ?? o.name) ?? [], board: token },
          evidence_url: job.absolute_url,
          evidence_snippet: clipSnippet(`${job.title} — ${job.departments?.[0]?.name ?? ""}`),
          r2_key,
          occurred_at: job.updated_at,
          account: { domain: r.domain ?? undefined, name: r.name },
        });
      }
    }
    return {
      events,
      cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor,
      // Without this the run records `0 events, ok` whether it scanned a
      // hundred boards and found nothing new or found nothing to scan at
      // all. `greenhouse_board` is operator-seeded on accounts.meta_json and
      // nothing sets it automatically, so seeded_accounts: 0 is the normal
      // state today — and the state an operator has no other way to see.
      meta: { seeded_accounts: seeded, boards_fetched: boardsFetched },
    };
  },
};

export default mod;
