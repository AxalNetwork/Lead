// Pure influence computation for Task #3.
//
// Extracted from sweep.ts so the per-sector slicing, broker score
// composition, power-node top-N, and the BOUNDED-COMPUTE guardrail
// can be unit-tested without touching D1. The sweep orchestrator
// calls computeInfluence(edges, sectorMap) and persists each row.
//
// Bounded-compute contract: when the scored graph exceeds NODE_CAP
// or EDGE_CAP, the function still returns a valid result — it just
// drops per-sector PageRank and broker score (both O(V*E) inner
// loops) and emits a `truncated_for_size` reason on the result so
// operators can see why those columns are null. Global PageRank is
// still computed because it's the most-valued signal and runs in
// fixed iterations.

import { pagerank, type PRNode, type PREdge } from "./pagerank";
import { brokerScores } from "./broker";

export interface ScoredEdge {
  src: string;
  dst: string;
  weight: number;
}

export interface EntityInfluenceRow {
  entity_id: string;
  pagerank_score: number;
  sector_pagerank_json: string | null;
  broker_score: number;
  in_degree: number;
  out_degree: number;
  total_degree: number;
  is_power_node: 0 | 1;
  primary_sector: string | null;
}

export interface ComputeInfluenceOpts {
  /**
   * Skip per-sector PageRank when the graph has more than this many
   * nodes. Per-sector PR is O(V*E) and the most expensive pass.
   * Defaults to 20_000 nodes — comfortably above present platform
   * population and well within Workers CPU budget at this density.
   */
  nodeCap?: number;
  /**
   * Skip broker score when the graph has more than this many edges.
   * Broker uses Burt's network constraint which is O(V*d̄^2); on
   * dense graphs this is the next-most-expensive pass.
   */
  edgeCap?: number;
  /** Per-sector top-N to flag as power nodes. */
  powerTopN?: number;
}

export interface ComputeInfluenceResult {
  rows: EntityInfluenceRow[];
  /** Sectors actually ranked (non-empty buckets with at least 2 nodes). */
  sectors_ranked: number;
  /** Power nodes flagged across all sectors. */
  power_nodes: number;
  /** True when nodeCap/edgeCap forced the function to skip a stage. */
  truncated_for_size: boolean;
  /** Reasons we degraded — empty when no truncation. */
  truncation_reasons: string[];
}

const DEFAULTS: Required<ComputeInfluenceOpts> = {
  nodeCap: 20_000,
  edgeCap: 200_000,
  powerTopN: 50,
};

export function computeInfluence(
  edges: readonly ScoredEdge[],
  primarySector: ReadonlyMap<string, string>,
  opts: ComputeInfluenceOpts = {},
): ComputeInfluenceResult {
  const o = { ...DEFAULTS, ...opts };
  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.src);
    nodeSet.add(e.dst);
  }
  if (nodeSet.size === 0) {
    return {
      rows: [],
      sectors_ranked: 0,
      power_nodes: 0,
      truncated_for_size: false,
      truncation_reasons: [],
    };
  }

  const reasons: string[] = [];
  const skipSectorAndBroker = nodeSet.size > o.nodeCap || edges.length > o.edgeCap;
  if (nodeSet.size > o.nodeCap) reasons.push(`node_cap_exceeded:${nodeSet.size}>${o.nodeCap}`);
  if (edges.length > o.edgeCap) reasons.push(`edge_cap_exceeded:${edges.length}>${o.edgeCap}`);

  // 1. Global PageRank — always runs (fixed iterations, O(V+E) per).
  const nodes: PRNode[] = Array.from(nodeSet).map((id) => ({ id }));
  const prEdges: PREdge[] = edges.map((e) => ({ src: e.src, dst: e.dst, weight: e.weight }));
  const global = pagerank(nodes, prEdges);

  // 2. Degrees — O(E), cheap, always runs.
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    outDeg.set(e.src, (outDeg.get(e.src) ?? 0) + 1);
    inDeg.set(e.dst, (inDeg.get(e.dst) ?? 0) + 1);
  }

  // 3. Broker score on undirected symmetrized graph — skipped on huge graphs.
  let broker = new Map<string, number>();
  if (!skipSectorAndBroker) {
    const undirected = new Map<string, Map<string, number>>();
    for (const e of edges) {
      if (!undirected.has(e.src)) undirected.set(e.src, new Map());
      if (!undirected.has(e.dst)) undirected.set(e.dst, new Map());
      const a = undirected.get(e.src)!;
      const b = undirected.get(e.dst)!;
      a.set(e.dst, Math.max(a.get(e.dst) ?? 0, e.weight));
      b.set(e.src, Math.max(b.get(e.src) ?? 0, e.weight));
    }
    broker = brokerScores({ adjacency: undirected });
  }

  // 4. Per-sector PageRank — partition by primary_sector, PR within each.
  const sectorBuckets = new Map<string, string[]>();
  for (const id of nodeSet) {
    const s = primarySector.get(id);
    if (!s) continue;
    if (!sectorBuckets.has(s)) sectorBuckets.set(s, []);
    sectorBuckets.get(s)!.push(id);
  }
  const sectorScores = new Map<string, Map<string, number>>(); // entity_id → sector → score
  let sectorsRanked = 0;
  if (!skipSectorAndBroker) {
    for (const [sector, ids] of sectorBuckets) {
      if (ids.length < 2) continue;
      const idSet = new Set(ids);
      const sectorEdges = prEdges.filter((e) => idSet.has(e.src) && idSet.has(e.dst));
      if (!sectorEdges.length) continue;
      const sub = pagerank(ids.map((id) => ({ id })), sectorEdges);
      for (const [id, sc] of sub.scores) {
        if (!sectorScores.has(id)) sectorScores.set(id, new Map());
        sectorScores.get(id)!.set(sector, sc);
      }
      sectorsRanked += 1;
    }
  }

  // 5. Power-node flagging — top-N per sector by sector-PageRank.
  const powerSet = new Set<string>();
  if (!skipSectorAndBroker) {
    for (const [sector, ids] of sectorBuckets) {
      if (ids.length < 2) continue;
      const ranked = ids
        .map((id) => ({ id, score: sectorScores.get(id)?.get(sector) ?? 0 }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, o.powerTopN);
      for (const r of ranked) powerSet.add(r.id);
    }
  }

  // 6. Compose rows.
  const rows: EntityInfluenceRow[] = [];
  for (const id of nodeSet) {
    const sectorJson = sectorScores.has(id)
      ? JSON.stringify(Object.fromEntries(sectorScores.get(id)!))
      : null;
    const inD = inDeg.get(id) ?? 0;
    const outD = outDeg.get(id) ?? 0;
    rows.push({
      entity_id: id,
      pagerank_score: global.scores.get(id) ?? 0,
      sector_pagerank_json: sectorJson,
      broker_score: broker.get(id) ?? 0,
      in_degree: inD,
      out_degree: outD,
      total_degree: inD + outD,
      is_power_node: powerSet.has(id) ? 1 : 0,
      primary_sector: primarySector.get(id) ?? null,
    });
  }

  return {
    rows,
    sectors_ranked: sectorsRanked,
    power_nodes: powerSet.size,
    truncated_for_size: skipSectorAndBroker,
    truncation_reasons: reasons,
  };
}
