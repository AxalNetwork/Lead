// Reddit correlation pivot.
//
// Reddit's about.json exposes karma + creation date + public icon URL +
// snoovatar metadata. We probe candidate handles and emit hits weighted by
// account age (older accounts are more likely a real long-lived identity).

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGet, pastDeadline, parallelMap, generateHandleVariants } from "./_util";

interface RedditAbout {
  data?: { name?: string; created_utc?: number; total_karma?: number; subreddit?: { public_description?: string } | null };
}

export async function runRedditCorrelation(_env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  const seeds = new Set<string>();
  for (const kh of facts.knownHandles) {
    if (kh.platform === "reddit") seeds.add(kh.handle);
    if (kh.platform === "github" || kh.platform === "twitter" || kh.platform === "hackernews") seeds.add(kh.handle);
  }
  for (const v of generateHandleVariants(facts).slice(0, 5)) seeds.add(v);
  if (!seeds.size) return [];

  const hits: PivotHit[] = [];
  await parallelMap([...seeds].slice(0, 6), 2, async (h) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    const r = await simpleGet(`https://www.reddit.com/user/${encodeURIComponent(h)}/about.json`, { timeoutMs: 4000, accept: "application/json" });
    if (!r.ok || !r.text) return;
    let body: RedditAbout;
    try { body = JSON.parse(r.text); } catch { return; }
    const u = body.data;
    if (!u || !u.name) return;

    // Cross-reference: does the public_description echo a known handle/site?
    let backLink = false;
    let backLinkDetail: Record<string, unknown> = {};
    const desc = u.subreddit?.public_description?.toLowerCase() ?? "";
    if (desc) {
      for (const s of facts.personalSites) {
        const dom = s.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (desc.includes(dom)) { backLink = true; backLinkDetail = { matched_site: s }; break; }
      }
      if (!backLink) for (const kh of facts.knownHandles) {
        if (desc.includes(kh.handle.toLowerCase())) { backLink = true; backLinkDetail = { matched_handle: kh.handle }; break; }
      }
    }
    const ageDays = u.created_utc ? Math.floor((Date.now() / 1000 - u.created_utc) / 86400) : 0;
    let confidence = 0.50;
    if (backLink) confidence = 0.92;
    else if (ageDays > 1825) confidence = 0.65; // >5y old
    else if (ageDays > 730) confidence = 0.58;  // >2y old

    hits.push({
      platform: "reddit",
      handle: u.name,
      url: `https://www.reddit.com/user/${u.name}`,
      link_method: "reddit",
      base_confidence: confidence,
      evidence_json: {
        total_karma: u.total_karma ?? null,
        age_days: ageDays,
        backlink_in_description: backLink,
        ...backLinkDetail,
      },
    });
  });

  return hits;
}
