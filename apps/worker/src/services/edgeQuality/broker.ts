// Burt's structural-holes broker score.
//
// For each ego, compute network constraint C(ego):
//   C(ego) = Σ_j (p_ij + Σ_k p_ik · p_kj)^2
// where p_ij = w_ij / Σ_q w_iq is ego's proportional investment of
// time/energy in neighbor j.
//
// Brokers occupy structural holes — they bridge otherwise-disconnected
// clusters and therefore have LOW constraint. We expose the inverted
// score `broker = 1 - clamp01(C)` so high = high broker.
//
// Pure module — no DB access. Operates on an undirected, weighted
// adjacency map. Caller is responsible for symmetrizing rel_edges if
// the relationship kind is directed.

export interface BrokerInput {
  /** Undirected weighted adjacency: nodeId → (neighborId → weight 0..1) */
  adjacency: Map<string, Map<string, number>>;
}

export function brokerScores(input: BrokerInput): Map<string, number> {
  const out = new Map<string, number>();
  const adj = input.adjacency;

  for (const [ego, neighbors] of adj) {
    if (neighbors.size === 0) {
      out.set(ego, 0);
      continue;
    }
    if (neighbors.size === 1) {
      // Single neighbor → maximally constrained → broker = 0.
      out.set(ego, 0);
      continue;
    }
    // Proportional weights p_ij for ego.
    let total = 0;
    for (const w of neighbors.values()) total += w;
    if (total === 0) {
      out.set(ego, 0);
      continue;
    }
    const p = new Map<string, number>();
    for (const [nbr, w] of neighbors) p.set(nbr, w / total);

    let constraint = 0;
    for (const [j, pij] of p) {
      // p_ij + Σ_k p_ik · p_kj  (k ranges over ego's other neighbors who also know j).
      let term = pij;
      for (const [k, pik] of p) {
        if (k === j) continue;
        const kAdj = adj.get(k);
        if (!kAdj || !kAdj.has(j)) continue;
        const kTotal = (() => {
          let t = 0;
          for (const w of kAdj.values()) t += w;
          return t;
        })();
        if (kTotal === 0) continue;
        const pkj = (kAdj.get(j) ?? 0) / kTotal;
        term += pik * pkj;
      }
      constraint += term * term;
    }
    // Burt's C ranges roughly 0..1 for typical graphs; clamp and invert.
    const c = constraint > 1 ? 1 : constraint < 0 ? 0 : constraint;
    out.set(ego, 1 - c);
  }
  return out;
}
