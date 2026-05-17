// Mutual-followers pivot.
//
// Compares the GitHub follower/following sets across known accounts. When
// a candidate handle on platform X shares >=3 mutual GitHub friends with
// our known github handle, we emit a corroborating hit. Lightweight —
// only uses the public GitHub API (no auth → 60 req/hour).

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGet, pastDeadline } from "./_util";

export async function runMutualFollowers(_env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  const gh = facts.knownHandles.find((h) => h.platform === "github");
  if (!gh) return [];

  // Fetch following list for the known GitHub handle.
  const followingRes = await simpleGet(`https://api.github.com/users/${encodeURIComponent(gh.handle)}/following?per_page=100`, { timeoutMs: 5000, accept: "application/vnd.github+json" });
  if (!followingRes.ok) return [];
  let following: Array<{ login: string }> = [];
  try { following = JSON.parse(followingRes.text); } catch { return []; }
  if (!Array.isArray(following) || !following.length) return [];

  const followingSet = new Set(following.map((u) => u.login.toLowerCase()));

  // For each other known github-flavored handle (variants from other
  // platforms that happen to also exist on GitHub), compute mutual count.
  const candidates = facts.knownHandles.filter((h) => h.platform !== "github" && h.handle && /^[a-z0-9-]{1,39}$/i.test(h.handle));
  const hits: PivotHit[] = [];
  for (const cand of candidates.slice(0, 4)) {
    if (pastDeadline(ctx.deadlineMs)) break;
    const candRes = await simpleGet(`https://api.github.com/users/${encodeURIComponent(cand.handle)}/following?per_page=100`, { timeoutMs: 5000, accept: "application/vnd.github+json" });
    if (!candRes.ok) continue;
    let candFollowing: Array<{ login: string }> = [];
    try { candFollowing = JSON.parse(candRes.text); } catch { continue; }
    if (!Array.isArray(candFollowing) || !candFollowing.length) continue;
    let mutual = 0;
    for (const u of candFollowing) if (followingSet.has(u.login.toLowerCase())) mutual++;
    if (mutual >= 3) {
      hits.push({
        platform: "github",
        handle: cand.handle,
        url: `https://github.com/${cand.handle}`,
        link_method: "mutual_followers",
        base_confidence: Math.min(0.78, 0.5 + mutual * 0.03),
        evidence_json: { mutual_count: mutual, vs: gh.handle, source_platform: cand.platform },
      });
    }
  }
  return hits;
}
