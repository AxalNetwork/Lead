// Gravatar lookup pivot.
//
// For each known email, compute the gravatar MD5 hash and request the
// public profile JSON. Gravatar profiles often surface multiple social
// URLs the user voluntarily linked — those become bio_url hits.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { md5Hex } from "../hashing";
import { simpleGetCached, pastDeadline, parallelMap } from "./_util";
import { parseProfileUrl } from "../platforms";

interface GravatarEntry {
  hash: string;
  profileUrl?: string;
  thumbnailUrl?: string;
  displayName?: string;
  preferredUsername?: string;
  accounts?: Array<{ url?: string; shortname?: string; username?: string; verified?: boolean }>;
  urls?: Array<{ value: string; title?: string }>;
}

export async function runGravatarLookup(env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (!facts.emails.length) return [];
  if (pastDeadline(ctx.deadlineMs)) return [];

  const hits: PivotHit[] = [];
  await parallelMap(facts.emails.slice(0, 5), 3, async (email) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    const md5 = md5Hex(email.trim().toLowerCase());
    const res = await simpleGetCached(env, `https://gravatar.com/${md5}.json`, { timeoutMs: 4000, accept: "application/json" });
    if (!res.ok) return;
    try {
      const data = JSON.parse(res.text) as { entry?: GravatarEntry[] };
      const e = data.entry?.[0];
      if (!e) return;

      // Always emit the gravatar handle itself.
      const gh = e.preferredUsername ?? md5;
      hits.push({
        platform: "gravatar",
        handle: gh,
        url: e.profileUrl ?? `https://gravatar.com/${gh}`,
        link_method: "gravatar",
        base_confidence: 0.94,
        evidence_json: { md5_hash: md5, email_source: email, display_name: e.displayName },
      });

      const collect = (raw: string) => {
        const p = parseProfileUrl(raw);
        if (p) {
          hits.push({
            platform: p.platform,
            handle: p.handle,
            url: raw,
            link_method: "gravatar",
            base_confidence: 0.88,
            evidence_json: { via: "gravatar_profile", gravatar_user: gh, email_source: email },
          });
        }
      };
      for (const acc of e.accounts ?? []) if (acc.url) collect(acc.url);
      for (const u of e.urls ?? []) if (u.value) collect(u.value);
    } catch { /* ignore */ }
  });

  return hits;
}
