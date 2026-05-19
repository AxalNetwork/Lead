// Task #5: "Suggested next investors" — pulls candidates for an open
// founder pipeline using the Task #4 intro-routing engine.
//
// Strategy: for an open pipeline, score top investors by reputation
// signals (preferring high follow_on_rate, low term_aggressiveness,
// positive NPS) and surface up to N who are NOT already on the
// pipeline. When the founder_entity_id is resolved AND Task #4's
// intro routing is available, we attach the top intro path per
// candidate; absent either, we return reputation-only suggestions.

import type { Env } from "../../types";

export interface SuggestionRow {
  investor_entity_id: string;
  display_name: string | null;
  reputation: {
    follow_on_rate_pct: number | null;
    founder_nps: number | null;
    term_aggressiveness_pct: number | null;
    sample_size: number;
    is_public: boolean;
  };
  intro_hops: number | null;            // null when no path or no founder entity
  intro_predicted_pct: number | null;
}

async function safeAll<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try { const r = await env.DB.prepare(sql).bind(...binds).all<T>(); return r.results ?? []; }
  catch { return []; }
}

/** Build the suggestion list. `founderEntityId` may be null if the
 *  founder couldn't be resolved against u_entities — in that case
 *  intro_hops / intro_predicted_pct are null on every row. */
export async function buildSuggestions(
  env: Env,
  pipelineId: string,
  founderEntityId: string | null,
  limit = 5,
): Promise<SuggestionRow[]> {
  // Investors already on the pipeline are excluded.
  const existing = new Set(
    (await safeAll<{ investor_entity_id: string }>(
      env,
      `SELECT investor_entity_id FROM founder_pipeline_investors WHERE pipeline_id = ?`,
      pipelineId,
    )).map((r) => r.investor_entity_id),
  );

  // Candidates: public reputation rows ordered by a simple founder-
  // friendly composite — high NPS, high follow-on, low aggressiveness.
  const candidates = await safeAll<{
    investor_entity_id: string;
    follow_on_rate_pct: number | null;
    founder_nps: number | null;
    term_aggressiveness_pct: number | null;
    sample_size: number;
    is_public: number;
  }>(
    env,
    `SELECT investor_entity_id, follow_on_rate_pct, founder_nps,
            term_aggressiveness_pct, sample_size, is_public
       FROM investor_reputation
      WHERE is_public = 1
      ORDER BY COALESCE(founder_nps, 0) DESC,
               COALESCE(follow_on_rate_pct, 0) DESC,
               COALESCE(term_aggressiveness_pct, 1) ASC
      LIMIT ?`,
    limit * 4 + existing.size,
  );

  const filtered = candidates.filter((c) => !existing.has(c.investor_entity_id)).slice(0, limit);

  // Best-effort display names. Wrapped so missing u_entities degrades.
  const names = new Map<string, string>();
  if (filtered.length) {
    const placeholders = filtered.map(() => "?").join(",");
    const rows = await safeAll<{ id: string; display_name: string | null }>(
      env,
      `SELECT id, display_name FROM u_entities WHERE id IN (${placeholders})`,
      ...filtered.map((f) => f.investor_entity_id),
    );
    for (const r of rows) if (r.display_name) names.set(r.id, r.display_name);
  }

  // Intro routing per candidate. Best-effort: any failure (no graph
  // adapter, no quality_score, no path) yields hops=null, pct=null.
  const introMap = new Map<string, { hops: number | null; pct: number | null }>();
  if (founderEntityId && filtered.length) {
    try {
      const { loadNeighborhood } = await import("../intros/graph");
      const { buildAdjacency, findKShortestPaths } = await import("../intros/pathfinder");
      for (const c of filtered) {
        try {
          const g = await loadNeighborhood(env, founderEntityId, c.investor_entity_id);
          const adj = buildAdjacency(g.edges);
          const scored = g.edges.filter((e) => typeof e.quality === "number");
          const mode: "weighted" | "hop_count_only" = scored.length > 0 ? "weighted" : "hop_count_only";
          const paths = findKShortestPaths(adj, founderEntityId, c.investor_entity_id, {
            max_hops: 3, k: 1, ranking_mode: mode, neighbor_cap: 200,
          });
          if (paths.length) {
            introMap.set(c.investor_entity_id, { hops: paths[0].hops.length, pct: null });
          }
        } catch { /* per-candidate failure is non-fatal */ }
      }
    } catch { /* intros module unavailable */ }
  }

  return filtered.map((c) => ({
    investor_entity_id: c.investor_entity_id,
    display_name: names.get(c.investor_entity_id) ?? null,
    reputation: {
      follow_on_rate_pct: c.follow_on_rate_pct,
      founder_nps: c.founder_nps,
      term_aggressiveness_pct: c.term_aggressiveness_pct,
      sample_size: c.sample_size,
      is_public: c.is_public === 1,
    },
    intro_hops: introMap.get(c.investor_entity_id)?.hops ?? null,
    intro_predicted_pct: introMap.get(c.investor_entity_id)?.pct ?? null,
  }));
}
