// Task #7: promote scraped social/web URLs into identity_handles + OSINT.
//
// After a person crawl writes contact facts (`linkedin_url`, `twitter_url`,
// `github_url`, … — both the canonical bare predicates emitted by the
// deterministic harvester AND the role-prefixed ones the AI mapper writes,
// e.g. `founder.linkedin_url`), this module parses each URL into a
// (platform, handle) pair and attaches it as an active identity handle via
// the canonical OSINT write path (`attachHandleOrQueueMerge`). Cross-entity
// conflicts are queued for operator merge review rather than overwritten.
//
// It then runs a bounded OSINT username-enumeration pass so handles
// discovered on one platform can surface the same person on others. The
// pass is best-effort: a failure (or no usable seed) never throws.

import type { Env } from "../../types";
import { attachHandleOrQueueMerge, resolveEntity } from "../../osint/resolve";
import { parseProfileUrl } from "../../osint/platforms";

// Matches the contact URL predicates whether bare (`linkedin_url`) or
// role-prefixed (`founder.linkedin_url`, `person.twitter_url`).
const SOCIAL_PREDICATE_RE = /(?:^|\.)(?:linkedin_url|twitter_url|github_url|personal_url|website)$/;

export interface PromoteResult {
  candidates: number;
  handlesAttached: number;
  queuedMerge: number;
  osintRan: boolean;
}

export async function promoteIdentityFromFacts(
  env: Env,
  entityId: string,
  opts: { runOsint?: boolean } = {},
): Promise<PromoteResult> {
  const rows = await env.DB.prepare(
    `SELECT predicate, value_text FROM facts
       WHERE entity_id = ? AND is_current = 1 AND value_text IS NOT NULL`,
  ).bind(entityId).all<{ predicate: string; value_text: string }>();

  let candidates = 0;
  let handlesAttached = 0;
  let queuedMerge = 0;
  const seen = new Set<string>();

  for (const r of rows.results ?? []) {
    if (!SOCIAL_PREDICATE_RE.test(r.predicate)) continue;
    const parsed = parseProfileUrl(r.value_text);
    if (!parsed) continue; // personal websites / unknown hosts: no handle.
    const key = `${parsed.platform}:${parsed.handle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates++;
    try {
      const res = await attachHandleOrQueueMerge(env, entityId, {
        platform: parsed.platform,
        handle: parsed.handle,
        url: r.value_text,
        link_method: "scrape",
        final_confidence: 0.7,
        evidence_json: { source: "profile_workflow_harvest", predicate: r.predicate },
        corroborations: 0,
      });
      if (res.attached) handlesAttached++;
      if (res.queuedMergeReview) queuedMerge++;
    } catch (e) {
      console.warn("identity promote attach failed", entityId, parsed.platform, (e as Error).message);
    }
  }

  // Run a bounded username-enumeration pass only when we have at least one
  // fresh seed handle — otherwise resolveEntity has nothing new to pivot on.
  let osintRan = false;
  if (opts.runOsint !== false && handlesAttached > 0) {
    try {
      await resolveEntity(env, entityId, {
        enabledPivots: ["username"],
        platformCap: 30,
        totalBudgetMs: 20_000,
      });
      osintRan = true;
    } catch (e) {
      console.warn("identity promote osint resolve failed", entityId, (e as Error).message);
    }
  }

  return { candidates, handlesAttached, queuedMerge, osintRan };
}
