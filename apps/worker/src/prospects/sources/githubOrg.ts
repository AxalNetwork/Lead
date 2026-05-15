// GitHub org activity — public events feed (no token needed up to 60/h).
// Emits team_expansion when org membership grows; product_launch on new
// public repos. Cursor stores the latest seen event id per org.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface AccountRow { id: string; domain: string | null; github_org: string | null; name: string }
interface GhEvent { id: string; type: string; created_at: string; actor: { login: string }; repo: { name: string } }

const mod: SourceModule = {
  slug: "github_org",
  label: "GitHub Org Public Events",
  schedule: "hourly",
  enabledByDefault: true,
  docsUrl: "https://docs.github.com/en/rest/activity/events",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const cursorMap: Record<string, string> = (() => { try { return ctx.cursor ? JSON.parse(ctx.cursor) as Record<string, string> : {}; } catch { return {}; } })();
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, github_org, name FROM accounts WHERE id = ? AND github_org IS NOT NULL`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, github_org, name FROM accounts WHERE github_org IS NOT NULL LIMIT 30`,
        ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      const org = (r.github_org ?? "").trim();
      if (!org) continue;
      const url = `https://api.github.com/orgs/${encodeURIComponent(org)}/events`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/vnd.github+json" });
      if (!res || !res.ok) continue;
      let list: GhEvent[] = [];
      try { list = JSON.parse(res.body) as GhEvent[]; } catch { continue; }
      const r2_key = await archiveRaw(ctx.env, "github_org", res.body, "json");
      const lastSeen = cursorMap[org];
      let newestId: string | undefined;
      for (const ev of list) {
        if (lastSeen && ev.id <= lastSeen) break;
        if (!newestId || ev.id > newestId) newestId = ev.id;
        let kind: "team_expansion" | "product_launch" | null = null;
        if (ev.type === "MemberEvent") kind = "team_expansion";
        else if (ev.type === "CreateEvent" && ev.repo?.name) kind = "product_launch";
        if (!kind) continue;
        events.push({
          kind,
          confidence: 0.6,
          payload: { type: ev.type, actor: ev.actor?.login, repo: ev.repo?.name, org },
          evidence_url: `https://github.com/${ev.repo?.name ?? org}`,
          evidence_snippet: clipSnippet(`${ev.type} by @${ev.actor?.login} on ${ev.repo?.name}`),
          r2_key,
          occurred_at: ev.created_at,
          account: { domain: r.domain ?? undefined, name: r.name, github_org: org },
        });
      }
      if (newestId) cursorMap[org] = newestId;
    }
    return { events, cursor: JSON.stringify(cursorMap) };
  },
};

export default mod;
