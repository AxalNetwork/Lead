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
  intro_predicted_pct: number | null;   // null in hop_count_only mode (never faked)
  ask_match: number | null;             // cosine overlap between raise_purpose and target hooks
  ranking_mode: "weighted" | "hop_count_only" | null;
}

async function safeAll<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try { const r = await env.DB.prepare(sql).bind(...binds).all<T>(); return r.results ?? []; }
  catch { return []; }
}

/** Build the suggestion list. `founderEntityId` may be null if the
 *  founder couldn't be resolved against u_entities — in that case
 *  intro_hops / intro_predicted_pct are null on every row.
 *
 *  `askContext` (the pipeline's raise_purpose) is threaded through the
 *  Task #4 intro-routing engine as the ask context: it drives the
 *  ask-match feature in `extractFeatures` so suggestions are ranked
 *  not just by graph proximity but by topical fit with the founder's
 *  current raise. */
export async function buildSuggestions(
  env: Env,
  pipelineId: string,
  founderEntityId: string | null,
  askContext: string | null,
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

  // Intro routing per candidate. Threads ask_context through the
  // Task #4 engine: pathfinder for hops, extractFeatures + predict
  // for the predicted-conversion score AND the ask_match feature
  // (cosine overlap between raise_purpose and target hooks).
  //
  // Per Task #4 honest-degradation: in hop_count_only mode (no edges
  // carry quality_score) intro_predicted_pct stays null — never faked.
  const ask = (askContext ?? "").toString().slice(0, 1000);
  const introMap = new Map<string, {
    hops: number | null;
    pct: number | null;
    ask_match: number | null;
    mode: "weighted" | "hop_count_only" | null;
  }>();
  if (founderEntityId && filtered.length) {
    try {
      const graphMod = await import("../intros/graph.js");
      const { buildAdjacency, findKShortestPaths } = await import("../intros/pathfinder.js");
      const { extractFeatures } = await import("../intros/features.js");
      const { predict, DEFAULT_WEIGHTS } = await import("../intros/model.js");
      let weights = DEFAULT_WEIGHTS;
      try {
        const { loadCurrentWeights } = await import("../intros/train.js");
        const w = await loadCurrentWeights(env);
        if (w?.weights) weights = w.weights;
      } catch { /* trained model unavailable — DEFAULT_WEIGHTS is the documented cold-start fallback */ }

      for (const c of filtered) {
        try {
          const g = await graphMod.loadNeighborhood(env, founderEntityId, c.investor_entity_id);
          const adj = buildAdjacency(g.edges);
          const scored = g.edges.filter((e) => typeof e.quality === "number");
          const mode: "weighted" | "hop_count_only" = scored.length > 0 ? "weighted" : "hop_count_only";
          const paths = findKShortestPaths(adj, founderEntityId, c.investor_entity_id, {
            max_hops: 3, k: 1, ranking_mode: mode, neighbor_cap: 200,
          });
          if (!paths.length) {
            introMap.set(c.investor_entity_id, { hops: null, pct: null, ask_match: null, mode });
            continue;
          }
          const path = paths[0];
          const [influence, hooks] = await Promise.all([
            graphMod.loadInfluenceMap(env, path.nodes),
            graphMod.loadTargetHooks(env, c.investor_entity_id),
          ]);
          const features = extractFeatures(path, ask, {
            target_pagerank: influence.pagerank[c.investor_entity_id] ?? null,
            broker_scores: Object.fromEntries(path.nodes.map((n) => [n, influence.broker[n] ?? null])),
            target_hooks: hooks,
          });
          const pct = mode === "weighted" ? predict(weights, features) : null;
          introMap.set(c.investor_entity_id, {
            hops: path.hops.length, pct, ask_match: features.ask_match, mode,
          });
        } catch { /* per-candidate failure is non-fatal */ }
      }
    } catch { /* intros module unavailable */ }
  }

  // Re-rank: when ask_context is present and we have weighted-mode
  // predictions, sort by (pct DESC, ask_match DESC) so topically-relevant
  // candidates with a real intro path rise to the top. Otherwise the
  // reputation-composite ordering from the SQL above is preserved.
  const ranked = [...filtered].sort((a, b) => {
    const ai = introMap.get(a.investor_entity_id);
    const bi = introMap.get(b.investor_entity_id);
    const ap = ai?.pct ?? -1;
    const bp = bi?.pct ?? -1;
    if (ap !== bp) return bp - ap;
    const am = ai?.ask_match ?? -1;
    const bm = bi?.ask_match ?? -1;
    return bm - am;
  });

  return ranked.map((c) => {
    const info = introMap.get(c.investor_entity_id);
    return {
      investor_entity_id: c.investor_entity_id,
      display_name: names.get(c.investor_entity_id) ?? null,
      reputation: {
        follow_on_rate_pct: c.follow_on_rate_pct,
        founder_nps: c.founder_nps,
        term_aggressiveness_pct: c.term_aggressiveness_pct,
        sample_size: c.sample_size,
        is_public: c.is_public === 1,
      },
      intro_hops: info?.hops ?? null,
      intro_predicted_pct: info?.pct ?? null,
      ask_match: info?.ask_match ?? null,
      ranking_mode: info?.mode ?? null,
    };
  });
}
