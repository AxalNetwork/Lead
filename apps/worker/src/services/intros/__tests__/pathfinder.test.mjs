import { test } from "node:test";
import assert from "node:assert/strict";

const pf = await import("../../../../test-dist/services/intros/pathfinder.js");

function edge(id, src, dst, quality) {
  return { edge_id: id, src, dst, kind: "knows", quality };
}

test("edgeWeight: weighted mode = 1/(q+0.1)", () => {
  assert.equal(pf.edgeWeight(0, "weighted"), 10);
  assert.ok(Math.abs(pf.edgeWeight(0.9, "weighted") - 1) < 1e-9);
  assert.equal(pf.edgeWeight(null, "weighted"), 10);
});

test("edgeWeight: hop_count_only is always 1", () => {
  assert.equal(pf.edgeWeight(0.0, "hop_count_only"), 1);
  assert.equal(pf.edgeWeight(0.9, "hop_count_only"), 1);
  assert.equal(pf.edgeWeight(null, "hop_count_only"), 1);
});

test("findKShortestPaths: empty graph → []", () => {
  const adj = pf.buildAdjacency([]);
  assert.deepEqual(pf.findKShortestPaths(adj, "A", "B"), []);
});

test("findKShortestPaths: src === dst → []", () => {
  const adj = pf.buildAdjacency([edge("e1", "A", "B", 0.5)]);
  assert.deepEqual(pf.findKShortestPaths(adj, "A", "A"), []);
});

test("findKShortestPaths: 1-hop direct edge", () => {
  const adj = pf.buildAdjacency([edge("e1", "A", "B", 0.5)]);
  const paths = pf.findKShortestPaths(adj, "A", "B");
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].nodes, ["A", "B"]);
  assert.equal(paths[0].hops.length, 1);
  assert.equal(paths[0].weakest_edge_quality, 0.5);
});

test("findKShortestPaths: k=3 returns paths sorted by total_weight ascending", () => {
  // A--B--D (low quality), A--C--D (high quality), A--D (direct, mid quality)
  const adj = pf.buildAdjacency([
    edge("e1", "A", "B", 0.1),
    edge("e2", "B", "D", 0.1),
    edge("e3", "A", "C", 0.9),
    edge("e4", "C", "D", 0.9),
    edge("e5", "A", "D", 0.5),
  ]);
  const paths = pf.findKShortestPaths(adj, "A", "D", { k: 3 });
  assert.ok(paths.length >= 2);
  // Direct A→D weight = 1/0.6 ≈ 1.67
  // A→C→D weight = 2/(1.0) = 2.0
  // A→B→D weight = 2/(0.2) = 10
  assert.deepEqual(paths[0].nodes, ["A", "D"]);
  assert.deepEqual(paths[1].nodes, ["A", "C", "D"]);
  for (let i = 1; i < paths.length; i++) {
    assert.ok(paths[i].total_weight >= paths[i - 1].total_weight);
  }
});

test("findKShortestPaths: hop cap is enforced (no 4-hop paths)", () => {
  // A-B-C-D-E, only 4-hop path exists between A and E.
  const adj = pf.buildAdjacency([
    edge("e1", "A", "B", 0.5),
    edge("e2", "B", "C", 0.5),
    edge("e3", "C", "D", 0.5),
    edge("e4", "D", "E", 0.5),
  ]);
  const paths = pf.findKShortestPaths(adj, "A", "E", { max_hops: 3 });
  assert.equal(paths.length, 0);
});

test("findKShortestPaths: max_hops=3 admits 3-hop path", () => {
  const adj = pf.buildAdjacency([
    edge("e1", "A", "B", 0.5),
    edge("e2", "B", "C", 0.5),
    edge("e3", "C", "D", 0.5),
  ]);
  const paths = pf.findKShortestPaths(adj, "A", "D", { max_hops: 3 });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].hops.length, 3);
});

test("findKShortestPaths: simple-path constraint (no repeated nodes)", () => {
  // Triangle A-B-C with cycle back. We should never revisit A.
  const adj = pf.buildAdjacency([
    edge("e1", "A", "B", 0.5),
    edge("e2", "B", "C", 0.5),
    edge("e3", "C", "A", 0.5),
  ]);
  const paths = pf.findKShortestPaths(adj, "A", "C");
  for (const p of paths) {
    const set = new Set(p.nodes);
    assert.equal(set.size, p.nodes.length, "no repeated nodes");
  }
});

test("findKShortestPaths: weakest_edge_quality = min along path, ignoring nulls", () => {
  const adj = pf.buildAdjacency([
    edge("e1", "A", "B", 0.8),
    edge("e2", "B", "C", 0.3),
    edge("e3", "C", "D", null),
  ]);
  const paths = pf.findKShortestPaths(adj, "A", "D");
  assert.equal(paths.length, 1);
  assert.equal(paths[0].weakest_edge_quality, 0.3);
});

test("findKShortestPaths: undirected — works either traversal direction", () => {
  const adj = pf.buildAdjacency([edge("e1", "B", "A", 0.5)]);
  const paths = pf.findKShortestPaths(adj, "A", "B");
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].nodes, ["A", "B"]);
});

test("findKShortestPaths: hop_count_only ranks by hops not quality", () => {
  // Low-quality direct edge vs high-quality 2-hop. In hop_count mode
  // the direct edge wins regardless of quality.
  const adj = pf.buildAdjacency([
    edge("e1", "A", "B", 0.05),
    edge("e2", "A", "C", 0.95),
    edge("e3", "C", "B", 0.95),
  ]);
  const paths = pf.findKShortestPaths(adj, "A", "B", { ranking_mode: "hop_count_only" });
  assert.deepEqual(paths[0].nodes, ["A", "B"]);
  assert.equal(paths[0].total_weight, 1);
});
