// Username enumeration pivot.
//
// For each handle variant, probe every known platform's existence endpoint
// (HEAD where supported, else GET with not-found hint matching). A bare
// hit returns a low base_confidence (0.45) — the resolve engine only
// auto-links when corroborated by another method.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { PLATFORMS } from "../platforms";
import { simpleGet, pastDeadline, parallelMap, bodyLooksLikeMiss, generateHandleVariants } from "./_util";
import { isNegativeCached, recordMiss } from "../negativeCache";

// Platforms we never sweep — heavy / anti-bot / require auth.
const SKIP = new Set(["facebook", "instagram", "linkedin", "tiktok", "personal_site", "discord", "telegram", "matrix", "ens", "etherscan", "snapshot"]);

export async function runUsernameEnumeration(env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  const variants = generateHandleVariants(facts);
  if (!variants.length) return [];

  const platforms = PLATFORMS.filter((p) => !SKIP.has(p.slug));
  const platformCap = ctx.platformCap ?? platforms.length;
  const sweep: Array<{ platform: typeof platforms[0]; handle: string }> = [];
  for (const p of platforms.slice(0, platformCap)) {
    for (const h of variants.slice(0, 4)) {
      sweep.push({ platform: p, handle: h });
    }
  }

  const hits: PivotHit[] = [];
  // Concurrency 6 — keeps us under per-host limits while finishing fast.
  await parallelMap(sweep, 6, async ({ platform, handle }) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    if (ctx.useNegativeCache && await isNegativeCached(env, facts.entityId, platform.slug, handle)) return;

    const url = platform.probeUrlOf ? platform.probeUrlOf(handle) : platform.urlOf(handle);
    const res = await simpleGet(url, { timeoutMs: 3500, accept: platform.probeUrlOf ? "application/json" : "text/html" });

    if (res.status === 404 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
      if (ctx.useNegativeCache) await recordMiss(env, facts.entityId, platform.slug, handle, `http_${res.status}`);
      return;
    }
    if (!res.ok) return;
    if (bodyLooksLikeMiss(res.text, platform.notFoundHints)) {
      if (ctx.useNegativeCache) await recordMiss(env, facts.entityId, platform.slug, handle, "body_hint_miss");
      return;
    }
    hits.push({
      platform: platform.slug,
      handle,
      url: platform.urlOf(handle),
      link_method: "username",
      base_confidence: 0.45,
      evidence_json: { http_status: res.status, probed_url: url },
    });
  });

  return hits;
}
