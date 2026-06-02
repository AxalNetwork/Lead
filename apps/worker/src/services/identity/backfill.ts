// Task #7: identity backfill sweep.
//
// Finds PERSON entities that already have scraped social/website/email
// facts but have NOT yet had those promoted into `identity_handles`, and
// runs `promoteIdentityFromFacts` on each. This catches entities crawled
// before the harvest+promote wiring landed, and any whose promote pass
// failed transiently. Bounded + paginated so it fits a single cron tick.

import type { Env } from "../../types";
import { promoteIdentityFromFacts } from "./promote";

export interface BackfillResult {
  scanned: number;
  promoted: number;
  handlesAttached: number;
  errors: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export async function runIdentityBackfill(
  env: Env,
  opts: { limit?: number; runOsint?: boolean } = {},
): Promise<BackfillResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // Candidate persons: active, with at least one current social/website
  // contact fact whose value can carry a handle, and NO active identity
  // handle yet. We target social/website predicates (not plain email)
  // because only those promote into `identity_handles`.
  const candidates = await env.DB.prepare(
    `SELECT DISTINCT e.id AS id
       FROM u_entities e
       JOIN facts f
         ON f.entity_id = e.id
        AND f.is_current = 1
        AND f.value_text IS NOT NULL
        AND ( f.predicate LIKE '%linkedin_url'
           OR f.predicate LIKE '%twitter_url'
           OR f.predicate LIKE '%github_url' )
      WHERE e.kind = 'person'
        AND e.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM identity_handles h
           WHERE h.entity_id = e.id AND h.is_active = 1
        )
      ORDER BY e.id ASC
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>();

  const result: BackfillResult = { scanned: 0, promoted: 0, handlesAttached: 0, errors: 0 };
  for (const row of candidates.results ?? []) {
    result.scanned += 1;
    try {
      const r = await promoteIdentityFromFacts(env, row.id, { runOsint: opts.runOsint });
      if (r.handlesAttached > 0) result.promoted += 1;
      result.handlesAttached += r.handlesAttached;
    } catch (e) {
      result.errors += 1;
      console.warn("identity backfill failed", row.id, (e as Error).message);
    }
  }
  return result;
}
