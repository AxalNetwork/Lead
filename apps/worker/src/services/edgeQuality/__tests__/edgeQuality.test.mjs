// Task #3 pure-layer tests.
//
// Covers aggregateSignals (decay/clamp/weighting), pagerank (mass
// conservation, hub ranking, convergence), and brokerScores (bridge
// vs triangle constraint). DB-bound paths (signals collectors and
// the sweep orchestrator) are integration-tested via the worker test
// harness.

import { test } from "node:test";
import assert from "node:assert/strict";

const { aggregateSignals } = await import("../../../../test-dist/services/edgeQuality/aggregate.js");
const { pagerank } = await import("../../../../test-dist/services/edgeQuality/pagerank.js");
const { brokerScores } = await import("../../../../test-dist/services/edgeQuality/broker.js");

test("aggregateSignals: returns 0 when no signals", () => {
  const r = aggregateSignals({ signals: {} });
  assert.equal(r.quality_score, 0);
  assert.deepEqual(r.signals_breakdown, {});
  assert.equal(r.last_interaction_at, null);
});

test("aggregateSignals: clamps signals to [0,1]", () => {
  const now = new Date().toISOString();
  const r = aggregateSignals({
    signals: {
      co_investment_5y: { value: 1.5, observed_at: now },
      public_co_mentions: { value: -0.2, observed_at: now },
    },
  });
  assert.equal(r.signals_breakdown.co_investment_5y.raw, 1);
  assert.equal(r.signals_breakdown.public_co_mentions.raw, 0);
});

test("aggregateSignals: applies 0.5x decay to signals older than 2y", () => {
  const old = new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const r = aggregateSignals({
    signals: {
      co_investment_5y: { value: 1.0, observed_at: old },
      public_co_mentions: { value: 1.0, observed_at: fresh },
    },
  });
  assert.equal(r.signals_breakdown.co_investment_5y.decayed, 0.5);
  assert.equal(r.signals_breakdown.public_co_mentions.decayed, 1);
});

test("aggregateSignals: picks latest observed_at as last_interaction_at", () => {
  const t1 = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  const t2 = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const r = aggregateSignals({
    signals: {
      co_investment_5y: { value: 0.5, observed_at: t1 },
      public_co_mentions: { value: 0.5, observed_at: t2 },
    },
  });
  assert.equal(r.last_interaction_at, t2);
});

test("aggregateSignals: explicit last_interaction_at overrides max-of-signals", () => {
  const explicit = "2024-01-15T00:00:00.000Z";
  const r = aggregateSignals({
    signals: { co_investment_5y: { value: 0.5, observed_at: "2023-01-01T00:00:00.000Z" } },
    last_interaction_at: explicit,
  });
  assert.equal(r.last_interaction_at, explicit);
});

test("aggregateSignals: quality_score is weighted mean and clamped to [0,1]", () => {
  const fresh = new Date().toISOString();
  const r = aggregateSignals({
    signals: {
      co_investment_5y: { value: 1.0, observed_at: fresh },
      public_co_mentions: { value: 0.0, observed_at: fresh },
    },
  });
  assert.ok(r.quality_score > 0);
  assert.ok(r.quality_score <= 1);
});

test("pagerank: handles empty graph", () => {
  const r = pagerank([], []);
  assert.equal(r.scores.size, 0);
});

test("pagerank: ranks a hub higher than its leaves", () => {
  const nodes = [{ id: "hub" }, { id: "a" }, { id: "b" }, { id: "c" }];
  const edges = [
    { src: "a", dst: "hub", weight: 1 },
    { src: "b", dst: "hub", weight: 1 },
    { src: "c", dst: "hub", weight: 1 },
  ];
  const r = pagerank(nodes, edges);
  const hub = r.scores.get("hub") ?? 0;
  const a = r.scores.get("a") ?? 0;
  assert.ok(hub > a, `hub ${hub} should outrank leaf ${a}`);
});

test("pagerank: scores sum to ~1 (conserved mass)", () => {
  const nodes = [{ id: "x" }, { id: "y" }, { id: "z" }];
  const edges = [
    { src: "x", dst: "y", weight: 1 },
    { src: "y", dst: "z", weight: 1 },
    { src: "z", dst: "x", weight: 1 },
  ];
  const r = pagerank(nodes, edges);
  let total = 0;
  for (const v of r.scores.values()) total += v;
  assert.ok(Math.abs(total - 1) < 0.01, `sum ${total} should approach 1`);
});

test("pagerank: converges within tolerance", () => {
  const nodes = [{ id: "a" }, { id: "b" }];
  const edges = [
    { src: "a", dst: "b", weight: 1 },
    { src: "b", dst: "a", weight: 1 },
  ];
  const r = pagerank(nodes, edges, { tolerance: 1e-6 });
  assert.equal(r.converged, true);
  assert.ok(Math.abs((r.scores.get("a") ?? 0) - 0.5) < 0.01);
  assert.ok(Math.abs((r.scores.get("b") ?? 0) - 0.5) < 0.01);
});

test("brokerScores: isolated node has broker = 0", () => {
  const r = brokerScores({ adjacency: new Map([["x", new Map()]]) });
  assert.equal(r.get("x"), 0);
});

test("brokerScores: bridge node has higher broker than clustered triangle peer", () => {
  const adj = new Map();
  adj.set("a", new Map([["b", 1]]));
  adj.set("b", new Map([["a", 1], ["c", 1]]));
  adj.set("c", new Map([["b", 1]]));
  adj.set("x", new Map([["y", 1], ["z", 1]]));
  adj.set("y", new Map([["x", 1], ["z", 1]]));
  adj.set("z", new Map([["x", 1], ["y", 1]]));
  const r = brokerScores({ adjacency: adj });
  const bridge = r.get("b") ?? 0;
  const tri = r.get("x") ?? 0;
  assert.ok(bridge > tri, `bridge ${bridge} should outscore triangle ${tri}`);
});
