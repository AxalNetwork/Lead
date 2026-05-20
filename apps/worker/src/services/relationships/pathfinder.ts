// Task #4: bidirectional BFS over rel_edges. Hop-capped at 4. Returns
// up to k shortest paths broken by Σ quality_score (descending). When
// no path exists within the hop cap we return [] honestly — never a
// fake "1 hop via unknown" edge.
//
// Intentionally separate from services/intros/pathfinder.ts (Task #4
// intro routing). This one answers "does an edge sequence exist?";
// that one answers "which route is most likely to convert?".

import type { Env } from "../../types";

interface Edge {
  id: string; src: string; dst: string; kind: string; quality: number;
}
interface NodeMeta { display_name: string | null; kind: string | null }

export interface PathStep { src: string; dst: string; kind: string; quality: number }
export interface FoundPath { hops: number; total_quality: number; nodes: string[]; edges: PathStep[] }

async function neighbors(env: Env, ids: string[]): Promise<Edge[]> {
  if (!ids.length) return [];
  const out: Edge[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const placeholders = slice.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT id, src_entity_id AS src, dst_entity_id AS dst, kind,
              COALESCE(quality_score, 0.5) AS quality
         FROM rel_edges
        WHERE src_entity_id IN (${placeholders}) OR dst_entity_id IN (${placeholders})`,
    ).bind(...slice, ...slice).all<Edge>();
    out.push(...(r.results ?? []));
  }
  return out;
}

export async function fetchNodeMeta(env: Env, ids: string[]): Promise<Map<string, NodeMeta>> {
  const m = new Map<string, NodeMeta>();
  if (!ids.length) return m;
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const placeholders = slice.map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT id, display_name, kind FROM u_entities WHERE id IN (${placeholders})`,
    ).bind(...slice).all<{ id: string; display_name: string | null; kind: string | null }>();
    for (const row of r.results ?? []) m.set(row.id, { display_name: row.display_name, kind: row.kind });
  }
  return m;
}

/**
 * Find up to `k` shortest paths from src to dst, hop-capped at maxHops.
 * Strategy: BFS layer by layer from src, then for any layer that reaches
 * dst, enumerate parents-of-parents to reconstruct all shortest paths.
 */
export async function findPaths(
  env: Env,
  src: string,
  dst: string,
  maxHops = 4,
  k = 5,
): Promise<FoundPath[]> {
  if (!src || !dst) return [];
  if (src === dst) return [{ hops: 0, total_quality: 0, nodes: [src], edges: [] }];
  const cap = Math.min(4, Math.max(1, maxHops));

  // parents[v] = list of { from, edge } across the shortest-path DAG
  const parents = new Map<string, { from: string; edge: Edge }[]>();
  let frontier = new Set<string>([src]);
  const seen = new Set<string>([src]);
  let foundAtHop = -1;

  for (let hop = 0; hop < cap && foundAtHop < 0; hop++) {
    const edges = await neighbors(env, Array.from(frontier));
    const next = new Set<string>();
    for (const e of edges) {
      const fromInFrontier = frontier.has(e.src) ? e.src : (frontier.has(e.dst) ? e.dst : null);
      if (!fromInFrontier) continue;
      const to = fromInFrontier === e.src ? e.dst : e.src;
      if (seen.has(to) && !next.has(to)) continue; // already in an earlier layer
      next.add(to);
      const list = parents.get(to) ?? [];
      list.push({ from: fromInFrontier, edge: e });
      parents.set(to, list);
    }
    for (const v of next) seen.add(v);
    if (next.has(dst)) foundAtHop = hop + 1;
    frontier = next;
    if (!frontier.size) break;
  }
  if (foundAtHop < 0) return [];

  // Reconstruct all shortest paths via DFS over parents DAG. `accNodes`
  // accumulates the dst-to-src chain (starts at [dst]); when we reach src
  // we reverse once for the final src→dst ordering. NEVER prepend src
  // again — it's already pushed onto accNodes by the recursive step that
  // arrived here.
  const results: FoundPath[] = [];
  function walk(node: string, accNodes: string[], accEdges: PathStep[], accQ: number, depth: number) {
    if (results.length >= 50) return; // hard cap to bound CPU
    if (node === src) {
      results.push({
        hops: foundAtHop, total_quality: accQ,
        nodes: [...accNodes].reverse(),
        edges: [...accEdges].reverse(),
      });
      return;
    }
    if (depth > foundAtHop) return;
    const ps = parents.get(node) ?? [];
    for (const p of ps) {
      const step: PathStep = { src: p.from, dst: node, kind: p.edge.kind, quality: p.edge.quality };
      walk(p.from, [...accNodes, p.from], [...accEdges, step], accQ + p.edge.quality, depth + 1);
    }
  }
  walk(dst, [dst], [], 0, 0);
  // Sort by hops asc, then total_quality desc.
  results.sort((a, b) => a.hops - b.hops || b.total_quality - a.total_quality);
  return results.slice(0, k);
}

/** Neighborhood (1-hop or N-hop) sub-graph for the Cytoscape UI. */
export async function neighborhood(env: Env, root: string, hops = 1, limit = 150): Promise<{
  nodes: { id: string; display_name: string | null; kind: string | null }[];
  edges: { id: string; src: string; dst: string; kind: string; quality: number }[];
}> {
  const h = Math.min(3, Math.max(1, hops));
  const visited = new Set<string>([root]);
  let frontier: string[] = [root];
  const allEdges: Edge[] = [];
  const seenEdgeIds = new Set<string>();
  for (let d = 0; d < h; d++) {
    const layer = await neighbors(env, frontier);
    const next: string[] = [];
    for (const e of layer) {
      if (seenEdgeIds.has(e.id)) continue;
      seenEdgeIds.add(e.id);
      allEdges.push(e);
      for (const v of [e.src, e.dst]) {
        if (!visited.has(v)) { visited.add(v); next.push(v); }
      }
      if (allEdges.length >= limit) break;
    }
    if (allEdges.length >= limit) break;
    frontier = next;
    if (!frontier.length) break;
  }
  const meta = await fetchNodeMeta(env, Array.from(visited));
  const nodes = Array.from(visited).map((id) => ({
    id, display_name: meta.get(id)?.display_name ?? null, kind: meta.get(id)?.kind ?? null,
  }));
  return {
    nodes,
    edges: allEdges.map((e) => ({ id: e.id, src: e.src, dst: e.dst, kind: e.kind, quality: e.quality })),
  };
}
