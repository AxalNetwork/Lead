import { test } from "node:test";
import assert from "node:assert/strict";

const f = await import("../../../../test-dist/services/intros/features.js");

function mkPath(nodes, qualities) {
  const hops = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    hops.push({ edge_id: `e${i}`, edge_kind: "knows", to_node: nodes[i + 1], quality: qualities[i] });
  }
  const weakest = qualities.filter((q) => typeof q === "number").reduce((m, q) => Math.min(m, q), Infinity);
  return {
    nodes,
    hops,
    total_weight: 0,
    weakest_edge_quality: Number.isFinite(weakest) ? weakest : null,
    ranking_mode: "weighted",
  };
}

test("tokenize: drops stopwords + punctuation", () => {
  const t = f.tokenize("The quick, brown fox!");
  assert.deepEqual(t.sort(), ["brown", "fox", "quick"]);
});

test("cosineTokenOverlap: empty inputs → 0", () => {
  assert.equal(f.cosineTokenOverlap("", "foo bar"), 0);
  assert.equal(f.cosineTokenOverlap("foo bar", ""), 0);
});

test("cosineTokenOverlap: identical token sets → 1.0", () => {
  assert.equal(f.cosineTokenOverlap("payments fintech", "payments fintech"), 1);
});

test("cosineTokenOverlap: zero overlap → 0", () => {
  assert.equal(f.cosineTokenOverlap("payments", "robotics"), 0);
});

test("cosineTokenOverlap: partial overlap is in (0,1)", () => {
  const c = f.cosineTokenOverlap("payments fintech checkout", "payments crypto wallet");
  assert.ok(c > 0 && c < 1);
});

test("extractFeatures: 1-hop path has no intermediates → broker_in_path=0", () => {
  const path = mkPath(["A", "B"], [0.6]);
  const out = f.extractFeatures(path, "Series A fintech raise", {
    target_pagerank: 0.5,
    broker_scores: { A: 0.9, B: 0.9 },  // endpoints don't count
    target_hooks: [],
  });
  assert.equal(out.path_length, 1);
  assert.equal(out.broker_in_path, 0);
  assert.equal(out.weakest_eq, 0.6);
  assert.equal(out.target_pr, 0.5);
  assert.equal(out.ask_match, 0);
});

test("extractFeatures: broker presence triggers when intermediate >= 0.6", () => {
  const path = mkPath(["A", "M", "B"], [0.5, 0.5]);
  const out = f.extractFeatures(path, "intro", {
    target_pagerank: 0,
    broker_scores: { A: 0.9, M: 0.7, B: 0.9 },
    target_hooks: [],
  });
  assert.equal(out.broker_in_path, 1);
});

test("extractFeatures: broker presence stays 0 when intermediate < 0.6", () => {
  const path = mkPath(["A", "M", "B"], [0.5, 0.5]);
  const out = f.extractFeatures(path, "intro", {
    target_pagerank: 0,
    broker_scores: { A: 0.9, M: 0.5, B: 0.9 },  // intermediate just below threshold
    target_hooks: [],
  });
  assert.equal(out.broker_in_path, 0);
});

test("extractFeatures: ask_match correlates with target_hook tokens", () => {
  const path = mkPath(["A", "B"], [0.5]);
  const out = f.extractFeatures(path, "want intro for payments fintech raise", {
    target_pagerank: 0.5,
    broker_scores: {},
    target_hooks: ["spoke at fintech conference", "led payments roundtable"],
  });
  assert.ok(out.ask_match > 0);
});

test("extractFeatures: weakest_eq=0 when path has no scored edges", () => {
  const path = mkPath(["A", "B"], [null]);
  const out = f.extractFeatures(path, "x", { target_pagerank: 0.5, broker_scores: {}, target_hooks: [] });
  assert.equal(out.weakest_eq, 0);
});

test("extractFeatures: clamps unbounded pagerank to [0,1]", () => {
  const path = mkPath(["A", "B"], [0.5]);
  const out = f.extractFeatures(path, "", { target_pagerank: 1.5, broker_scores: {}, target_hooks: [] });
  assert.equal(out.target_pr, 1);
  const out2 = f.extractFeatures(path, "", { target_pagerank: -0.3, broker_scores: {}, target_hooks: [] });
  assert.equal(out2.target_pr, 0);
});
