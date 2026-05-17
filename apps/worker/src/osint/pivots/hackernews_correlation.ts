// Hacker News correlation pivot.
//
// HN profiles expose an `about` field that frequently contains URLs to the
// user's homepage / GitHub / Twitter — strong signal that the HN handle
// is the same person.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGetCached, pastDeadline, parallelMap, generateHandleVariants } from "./_util";
import { parseProfileUrl } from "../platforms";

interface HNUser { id: string; about?: string | null; karma?: number; created?: number }

export async function runHackerNewsCorrelation(env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  // Build seed handles: known HN handles + variants from email/name/github/twitter.
  const seeds = new Set<string>();
  for (const kh of facts.knownHandles) {
    if (kh.platform === "hackernews") seeds.add(kh.handle);
    if (kh.platform === "github" || kh.platform === "twitter") seeds.add(kh.handle);
  }
  for (const v of generateHandleVariants(facts).slice(0, 6)) seeds.add(v);
  if (!seeds.size) return [];

  const hits: PivotHit[] = [];
  await parallelMap([...seeds].slice(0, 8), 3, async (h) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    const r = await simpleGetCached(env, `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(h)}.json`, { timeoutMs: 4000, accept: "application/json" });
    if (!r.ok || !r.text || r.text === "null" || r.text === "negative_cache") return;
    let u: HNUser;
    try { u = JSON.parse(r.text); } catch { return; }
    if (!u || !u.id) return;

    // Cross-reference: does the about field link back to a known site/handle?
    let backLink = false;
    let backLinkDetail: Record<string, unknown> = {};
    if (u.about) {
      for (const s of facts.personalSites) {
        if (u.about.toLowerCase().includes(s.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, ""))) {
          backLink = true; backLinkDetail = { matched: s, channel: "personal_site_in_about" }; break;
        }
      }
      if (!backLink) {
        for (const kh of facts.knownHandles) {
          if (u.about.toLowerCase().includes(kh.handle.toLowerCase())) {
            backLink = true; backLinkDetail = { matched_handle: kh.handle, channel: "known_handle_in_about" }; break;
          }
        }
      }
    }

    const confidence = backLink ? 0.92 : 0.55;
    hits.push({
      platform: "hackernews",
      handle: u.id,
      url: `https://news.ycombinator.com/user?id=${u.id}`,
      link_method: "hackernews",
      base_confidence: confidence,
      evidence_json: { karma: u.karma ?? null, created: u.created ?? null, about_has_backlink: backLink, ...backLinkDetail },
    });

    // If the about contains URLs that parse into other platforms, emit them
    // as bio_url hits — the HN profile is the source.
    if (u.about) {
      const urls = u.about.match(/\bhttps?:\/\/[^\s"'<>)]+/gi) ?? [];
      for (const raw of urls.slice(0, 20)) {
        const cleaned = raw.replace(/[.,;)]+$/, "");
        const p = parseProfileUrl(cleaned);
        if (p) {
          hits.push({
            platform: p.platform,
            handle: p.handle,
            url: cleaned,
            link_method: "bio_url",
            base_confidence: 0.78,
            evidence_json: { via: "hn_about", hn_user: u.id },
          });
        }
      }
    }
  });

  return hits;
}
