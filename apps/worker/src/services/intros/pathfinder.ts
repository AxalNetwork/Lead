// Pure pathfinder for intro routing. No DB access — accepts a pre-built
// adjacency graph and returns the top-K shortest paths between two nodes
// using a simplified Yen's k-shortest-paths algorithm.
//
// Why "simplified": with the spec's hop cap of 3, the search space is
// bounded by the size of the 3-hop neighborhood. We enumerate every
// simple path of length ≤ MAX_HOPS via DFS and rank by total weight,
// rather than running full Yen with repeated Dijkstra deviations. The
// result is identical for k-shortest-with-hop-cap and the code is much
// easier to verify.
//
// Edge weight contract: weight = 1 / (edge.quality_score + 0.1).
// When quality_score is NULL, the caller decides the ranking mode:
//   - "weighted":      missing scores are treated as 0 (weight=10).
//   - "hop_count_only": every edge weighs 1.0 (degenerates to BFS).
//
// All edges are treated as undirected for routing purposes (intro
// graph is socially symmetric).

export interface PFEdge {
  /** stable id from rel_edges.id */
  edge_id: string;
  /** symmetrized: src/dst are interchangeable for routing */
  src: string;
  dst: string;
  /** rel_edges.kind */
  kind: string;
  /** rel_edges.quality_score; null when unscored */
  quality: number | null;
}

export interface PFPathHop {
  edge_id: string;
  edge_kind: string;
  /** the *next* node on this hop (i.e. where the hop lands) */
  to_node: string;
  /** edge quality_score; null when unscored */
  quality: number | null;
}

export interface PFPath {
  /** [source, hop1, hop2, ...]; length = hops+1 */
  nodes: string[];
  hops: PFPathHop[];
  /** sum of 1/(q+0.1) (weighted) or hop count (hop_count_only) */
  total_weight: number;
  /** min(quality) along the path, ignoring nulls; null if every edge is null */
  weakest_edge_quality: number | null;
  ranking_mode: "weighted" | "hop_count_only";
}

export interface PFOptions {
  max_hops?: number;
  k?: number;
  ranking_mode?: "weighted" | "hop_count_only";
  /** soft cap on neighbors expanded per node to bound CPU */
  neighbor_cap?: number;
}

const DEFAULTS = {
  max_hops: 3,
  k: 5,
  ranking_mode: "weighted" as const,
  neighbor_cap: 200,
};

/** weight contract: 1 / (q + 0.1); null quality → q=0 ⇒ weight=10 */
export function edgeWeight(quality: number | null, mode: "weighted" | "hop_count_only"): number {
  if (mode === "hop_count_only") return 1;
  const q = typeof quality === "number" && Number.isFinite(quality) ? Math.max(0, Math.min(1, quality)) : 0;
  return 1 / (q + 0.1);
}

/**
 * Returns the top-K shortest paths between src and dst, with simple-path
 * (no repeated node) and hop-cap constraints. Empty array if src===dst,
 * if the graph is empty, or if no path exists.
 */
export function findKShortestPaths(
  adjacency: Map<string, PFEdge[]>,
  src: string,
  dst: string,
  options: PFOptions = {},
): PFPath[] {
  const max_hops = options.max_hops ?? DEFAULTS.max_hops;
  const k = options.k ?? DEFAULTS.k;
  const mode = options.ranking_mode ?? DEFAULTS.ranking_mode;
  const neighbor_cap = options.neighbor_cap ?? DEFAULTS.neighbor_cap;

  if (!src || !dst || src === dst) return [];
  if (!adjacency.has(src)) return [];

  const found: PFPath[] = [];

  // Iterative DFS to avoid recursion limits on dense neighborhoods.
  // Each frame: { node, depth, visitedSet, hopsAccum, weightAccum }
  function dfs(): void {
    const stack: Array<{
      node: string;
      depth: number;
      visited: Set<string>;
      nodes: string[];
      hops: PFPathHop[];
      weight: number;
      minQ: number | null;
    }> = [{
      node: src,
      depth: 0,
      visited: new Set([src]),
      nodes: [src],
      hops: [],
      weight: 0,
      minQ: null,
    }];

    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.node === dst && frame.depth > 0) {
        found.push({
          nodes: frame.nodes.slice(),
          hops: frame.hops.slice(),
          total_weight: frame.weight,
          weakest_edge_quality: frame.minQ,
          ranking_mode: mode,
        });
        continue;
      }
      if (frame.depth >= max_hops) continue;
      const neighbors = adjacency.get(frame.node);
      if (!neighbors || !neighbors.length) continue;
      // neighbor_cap: when a node has too many neighbors, we deterministically
      // take the highest-quality slice. quality null sorts last.
      const sliced = neighbors.length > neighbor_cap
        ? neighbors.slice().sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1)).slice(0, neighbor_cap)
        : neighbors;
      for (const e of sliced) {
        const next = e.src === frame.node ? e.dst : e.src;
        if (frame.visited.has(next)) continue;
        const w = edgeWeight(e.quality, mode);
        const nq = typeof e.quality === "number" && Number.isFinite(e.quality)
          ? (frame.minQ == null ? e.quality : Math.min(frame.minQ, e.quality))
          : frame.minQ;
        const visited2 = new Set(frame.visited);
        visited2.add(next);
        stack.push({
          node: next,
          depth: frame.depth + 1,
          visited: visited2,
          nodes: [...frame.nodes, next],
          hops: [...frame.hops, { edge_id: e.edge_id, edge_kind: e.kind, to_node: next, quality: e.quality }],
          weight: frame.weight + w,
          minQ: nq,
        });
      }
    }
  }

  dfs();
  found.sort((a, b) => a.total_weight - b.total_weight);
  return found.slice(0, k);
}

/** Builds an undirected adjacency map from a list of edges. */
export function buildAdjacency(edges: PFEdge[]): Map<string, PFEdge[]> {
  const adj = new Map<string, PFEdge[]>();
  for (const e of edges) {
    if (!adj.has(e.src)) adj.set(e.src, []);
    if (!adj.has(e.dst)) adj.set(e.dst, []);
    adj.get(e.src)!.push(e);
    adj.get(e.dst)!.push(e);
  }
  return adj;
}
