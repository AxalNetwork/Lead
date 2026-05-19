// DB-bound helpers for the intro-routing endpoint. Loads a bounded
// neighborhood from rel_edges for the pathfinder, fetches influence
// + conversation hooks for feature extraction, and resolves display
// names for the response payload.
//
// Bounds:
//   - 2-frontier BFS: viewer's 1- and 2-hop neighbors, target's 1- and
//     2-hop neighbors. Their union is the candidate node set; we then
//     load every edge whose endpoints are both inside that set. A
//     3-hop path between viewer and target must traverse this set by
//     construction.
//   - Per-node neighbor cap of 250 to keep the BFS frontier bounded
//     even on hub-heavy graphs (Sequoia, a16z, …).
//   - Maximum total nodes inspected: 10_000 — beyond that we still
//     attempt the pathfind but warn that the result may be truncated.

import type { Env } from "../../types";
import type { PFEdge } from "./pathfinder";

const NEIGHBOR_CAP = 250;
const FRONTIER_NODE_CAP = 10_000;

export interface NeighborhoodGraph {
  nodes: Set<string>;
  edges: PFEdge[];
  truncated: boolean;
}

/** Loads up to 2-hop neighborhoods around both endpoints from rel_edges
 *  and returns every edge that lives strictly inside the union. */
export async function loadNeighborhood(
  env: Env,
  src: string,
  dst: string,
): Promise<NeighborhoodGraph> {
  const nodes = new Set<string>([src, dst]);
  const frontier = new Set<string>([src, dst]);
  let truncated = false;

  for (let hop = 0; hop < 2 && frontier.size > 0; hop++) {
    if (nodes.size > FRONTIER_NODE_CAP) { truncated = true; break; }
    const ids = Array.from(frontier);
    frontier.clear();
    // chunked IN to stay under D1 bind limits
    for (let i = 0; i < ids.length; i += 50) {
      const slice = ids.slice(i, i + 50);
      const placeholders = slice.map(() => "?").join(",");
      let r: { results?: Array<{ src_entity_id: string; dst_entity_id: string }> };
      try {
        r = await env.DB.prepare(
          `SELECT src_entity_id, dst_entity_id FROM rel_edges
            WHERE src_entity_id IN (${placeholders})
               OR dst_entity_id IN (${placeholders})
            LIMIT ?`,
        ).bind(...slice, ...slice, NEIGHBOR_CAP * slice.length).all<{ src_entity_id: string; dst_entity_id: string }>();
      } catch {
        // rel_edges may be absent in some test DBs — caller handles empty result.
        return { nodes, edges: [], truncated: true };
      }
      for (const row of r.results ?? []) {
        for (const n of [row.src_entity_id, row.dst_entity_id]) {
          if (!nodes.has(n)) {
            nodes.add(n);
            frontier.add(n);
            if (nodes.size > FRONTIER_NODE_CAP) { truncated = true; break; }
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
  }

  // Pull every edge with both endpoints inside `nodes`. We page through
  // a sorted id list to keep bind counts safe; the WHERE filter
  // happens client-side because SQLite IN-clauses don't compose well
  // across both sides of an edge.
  const edges: PFEdge[] = [];
  const ids = Array.from(nodes);
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const placeholders = slice.map(() => "?").join(",");
    try {
      const r = await env.DB.prepare(
        `SELECT id, src_entity_id, dst_entity_id, kind, quality_score
           FROM rel_edges
          WHERE src_entity_id IN (${placeholders}) OR dst_entity_id IN (${placeholders})`,
      ).bind(...slice, ...slice).all<{
        id: string; src_entity_id: string; dst_entity_id: string; kind: string; quality_score: number | null;
      }>();
      for (const row of r.results ?? []) {
        if (nodes.has(row.src_entity_id) && nodes.has(row.dst_entity_id)) {
          edges.push({
            edge_id: row.id,
            src: row.src_entity_id,
            dst: row.dst_entity_id,
            kind: row.kind,
            quality: row.quality_score,
          });
        }
      }
    } catch {
      // best-effort
    }
  }
  // dedup edges by id
  const seen = new Set<string>();
  const unique = edges.filter((e) => (seen.has(e.edge_id) ? false : (seen.add(e.edge_id), true)));
  return { nodes, edges: unique, truncated };
}

/** Influence row subset needed for feature extraction. */
export async function loadInfluenceMap(
  env: Env,
  ids: string[],
): Promise<{ pagerank: Record<string, number | null>; broker: Record<string, number | null> }> {
  const pagerank: Record<string, number | null> = {};
  const broker: Record<string, number | null> = {};
  if (!ids.length) return { pagerank, broker };
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    try {
      const r = await env.DB.prepare(
        `SELECT entity_id, pagerank_score, broker_score
           FROM entity_influence
          WHERE entity_id IN (${slice.map(() => "?").join(",")})`,
      ).bind(...slice).all<{ entity_id: string; pagerank_score: number | null; broker_score: number | null }>();
      for (const row of r.results ?? []) {
        pagerank[row.entity_id] = row.pagerank_score;
        broker[row.entity_id] = row.broker_score;
      }
    } catch {
      // entity_influence may be absent — left as undefined → feature extractor uses 0.
    }
  }
  return { pagerank, broker };
}

/** Returns up to N recent conversation hook texts for the target. */
export async function loadTargetHooks(env: Env, targetId: string, limit: number = 20): Promise<string[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT hook_text FROM conversation_hooks
        WHERE entity_id = ?
        ORDER BY observed_at DESC LIMIT ?`,
    ).bind(targetId, limit).all<{ hook_text: string }>();
    return (r.results ?? []).map((x) => x.hook_text).filter(Boolean);
  } catch {
    return [];
  }
}

/** Bulk-fetch display names for response payload. */
export async function loadDisplayNames(env: Env, ids: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    try {
      const r = await env.DB.prepare(
        `SELECT id, display_name FROM u_entities WHERE id IN (${slice.map(() => "?").join(",")})`,
      ).bind(...slice).all<{ id: string; display_name: string | null }>();
      for (const row of r.results ?? []) out[row.id] = row.display_name;
    } catch {
      // u_entities may be absent in tests — leave undefined.
    }
  }
  return out;
}

/** Parse the quality_signals_json column for a single edge id. */
export async function loadEdgeSignals(env: Env, edgeId: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await env.DB.prepare(
      `SELECT quality_signals_json FROM rel_edges WHERE id = ?`,
    ).bind(edgeId).first<{ quality_signals_json: string | null }>();
    if (!r || !r.quality_signals_json) return null;
    return JSON.parse(r.quality_signals_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
