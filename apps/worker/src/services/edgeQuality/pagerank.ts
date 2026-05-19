// Pure PageRank over a weighted directed graph.
//
// Power-iteration variant with damping factor 0.85, fixed 30 iterations
// or convergence within 1e-6 L1 delta. Works on any node-set without
// DB access so it can be unit-tested on fixture graphs.
//
// Edge weight = quality_score (clamped 0..1, defaults to 0.5 when null
// so an unscored edge still contributes a baseline signal).

export interface PRNode {
  id: string;
}
export interface PREdge {
  src: string;
  dst: string;
  weight: number;
}

export interface PRResult {
  scores: Map<string, number>;
  iterations: number;
  converged: boolean;
}

export function pagerank(
  nodes: ReadonlyArray<PRNode>,
  edges: ReadonlyArray<PREdge>,
  opts: { damping?: number; maxIter?: number; tolerance?: number } = {},
): PRResult {
  const damping = opts.damping ?? 0.85;
  const maxIter = opts.maxIter ?? 30;
  const tolerance = opts.tolerance ?? 1e-6;
  const n = nodes.length;
  if (n === 0) return { scores: new Map(), iterations: 0, converged: true };

  // Outgoing weighted edges per node.
  const out = new Map<string, Array<{ dst: string; w: number }>>();
  const sumOut = new Map<string, number>();
  for (const node of nodes) {
    out.set(node.id, []);
    sumOut.set(node.id, 0);
  }
  for (const e of edges) {
    if (!out.has(e.src) || !out.has(e.dst)) continue;
    const w = clampWeight(e.weight);
    out.get(e.src)!.push({ dst: e.dst, w });
    sumOut.set(e.src, (sumOut.get(e.src) ?? 0) + w);
  }

  // Initialize uniform.
  const init = 1 / n;
  let scores = new Map<string, number>();
  for (const node of nodes) scores.set(node.id, init);

  let iter = 0;
  let converged = false;
  for (; iter < maxIter; iter++) {
    const next = new Map<string, number>();
    // Dangling-node mass redistributed uniformly (standard PR convention).
    let danglingMass = 0;
    for (const node of nodes) {
      if ((sumOut.get(node.id) ?? 0) === 0) {
        danglingMass += scores.get(node.id) ?? 0;
      }
    }
    for (const node of nodes) {
      next.set(node.id, (1 - damping) / n + (damping * danglingMass) / n);
    }
    for (const node of nodes) {
      const sumW = sumOut.get(node.id) ?? 0;
      if (sumW === 0) continue;
      const share = (damping * (scores.get(node.id) ?? 0)) / sumW;
      for (const link of out.get(node.id)!) {
        next.set(link.dst, (next.get(link.dst) ?? 0) + share * link.w);
      }
    }
    let delta = 0;
    for (const node of nodes) {
      delta += Math.abs((next.get(node.id) ?? 0) - (scores.get(node.id) ?? 0));
    }
    scores = next;
    if (delta < tolerance) {
      converged = true;
      iter += 1;
      break;
    }
  }
  return { scores, iterations: iter, converged };
}

function clampWeight(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 0;
  if (w > 1) return 1;
  return w;
}
