// Task #3 pure-layer tests.
//
// Covers:
// - aggregateSignals (decay/clamp/weighting)
// - pagerank (mass conservation, hub ranking, convergence)
// - brokerScores (bridge vs triangle constraint)
// - signalScale helpers (logScale, dates, board-overlap, jaccard)
// - computeInfluence (per-sector PR slicing, power-node top-N,
//   nodeCap/edgeCap guardrails, degree counts, pruning shape)
//
// DB-bound paths (signals collectors and the sweep orchestrator's
// DB I/O) are integration-tested via the worker test harness; the
// computation those paths feed into is exercised here in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";

const { aggregateSignals } = await import("../../../../test-dist/services/edgeQuality/aggregate.js");
const { pagerank } = await import("../../../../test-dist/services/edgeQuality/pagerank.js");
const { brokerScores } = await import("../../../../test-dist/services/edgeQuality/broker.js");
const {
  logScale,
  maxDate,
  minDate,
  monthsBetween,
  boardOverlapMonths,
  jaccardNeighbors,
} = await import("../../../../test-dist/services/edgeQuality/signalScale.js");
const { computeInfluence } = await import("../../../../test-dist/services/edgeQuality/influence.js");

// ---------- aggregate ----------

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

// ---------- pagerank ----------

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

// ---------- broker ----------

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

// ---------- signalScale (collector-feeding helpers) ----------

test("logScale: 0 and negative counts return 0", () => {
  assert.equal(logScale(0, 10), 0);
  assert.equal(logScale(-5, 10), 0);
});

test("logScale: value at the knee returns 1", () => {
  assert.ok(Math.abs(logScale(10, 10) - 1) < 1e-9);
});

test("logScale: monotonic and capped at 1", () => {
  const a = logScale(1, 10);
  const b = logScale(5, 10);
  const c = logScale(100, 10);
  assert.ok(a < b);
  assert.ok(b <= 1);
  assert.equal(c, 1);
});

test("logScale: invalid knee returns 0", () => {
  assert.equal(logScale(5, 0), 0);
  assert.equal(logScale(5, -1), 0);
});

test("maxDate / minDate: handle nulls", () => {
  assert.equal(maxDate(null, "2024-01-01"), "2024-01-01");
  assert.equal(maxDate("2024-06-01", null), "2024-06-01");
  assert.equal(maxDate(null, null), null);
  assert.equal(minDate("2024-06-01", "2023-01-01"), "2023-01-01");
});

test("monthsBetween: invalid dates return 0", () => {
  assert.equal(monthsBetween("not-a-date", "2024-01-01"), 0);
});

test("monthsBetween: ~12 months for one year", () => {
  const m = monthsBetween("2024-01-01", "2025-01-01");
  assert.ok(Math.abs(m - 12) < 0.2);
});

test("boardOverlapMonths: returns 0 when windows don't overlap", () => {
  const m = boardOverlapMonths("2020-01-01", "2020-12-31", "2022-01-01", "2022-12-31");
  assert.equal(m, 0);
});

test("boardOverlapMonths: counts overlap months for nested windows", () => {
  // person A: 2020-01 → 2024-01.  person B: 2022-01 → 2023-01 (1y overlap).
  const m = boardOverlapMonths("2020-01-01", "2024-01-01", "2022-01-01", "2023-01-01");
  assert.ok(m > 11 && m < 13, `expected ~12 months, got ${m}`);
});

test("boardOverlapMonths: open end-dates use 'now'", () => {
  const now = "2024-06-01T00:00:00Z";
  const m = boardOverlapMonths("2023-06-01", null, "2023-12-01", null, now);
  assert.ok(m > 5 && m < 7, `expected ~6 months, got ${m}`);
});

test("jaccardNeighbors: returns 0 on empty sets", () => {
  assert.equal(jaccardNeighbors([], [], new Set()), 0);
});

test("jaccardNeighbors: excludes the edge endpoints themselves", () => {
  const ex = new Set(["a", "b"]);
  // a's nbrs include b (excluded) + c + d; b's nbrs include a (excluded) + c + e.
  // Effective A = {c, d}, B = {c, e}. inter=1, union=3 → 1/3.
  const j = jaccardNeighbors(["b", "c", "d"], ["a", "c", "e"], ex);
  assert.ok(Math.abs(j - 1 / 3) < 1e-9, `expected 1/3, got ${j}`);
});

test("jaccardNeighbors: identical neighbor sets → 1.0", () => {
  const j = jaccardNeighbors(["x", "y", "z"], ["x", "y", "z"], new Set());
  assert.equal(j, 1);
});

test("jaccardNeighbors: disjoint neighbor sets → 0", () => {
  const j = jaccardNeighbors(["a", "b"], ["c", "d"], new Set());
  assert.equal(j, 0);
});

// ---------- computeInfluence (sweep orchestration logic) ----------

test("computeInfluence: empty graph returns empty result, no truncation", () => {
  const r = computeInfluence([], new Map());
  assert.equal(r.rows.length, 0);
  assert.equal(r.sectors_ranked, 0);
  assert.equal(r.power_nodes, 0);
  assert.equal(r.truncated_for_size, false);
  assert.deepEqual(r.truncation_reasons, []);
});

test("computeInfluence: in/out degree counts are correct", () => {
  const edges = [
    { src: "a", dst: "b", weight: 0.5 },
    { src: "a", dst: "c", weight: 0.5 },
    { src: "b", dst: "c", weight: 0.5 },
  ];
  const r = computeInfluence(edges, new Map());
  const byId = new Map(r.rows.map((x) => [x.entity_id, x]));
  assert.equal(byId.get("a").out_degree, 2);
  assert.equal(byId.get("a").in_degree, 0);
  assert.equal(byId.get("b").out_degree, 1);
  assert.equal(byId.get("b").in_degree, 1);
  assert.equal(byId.get("c").out_degree, 0);
  assert.equal(byId.get("c").in_degree, 2);
  assert.equal(byId.get("c").total_degree, 2);
});

test("computeInfluence: per-sector PageRank only ranks within-sector edges", () => {
  // Two sectors: 'ai' = {a, b, c}, 'fintech' = {x, y}. Cross-sector
  // edge a→x must NOT contribute to either sector's PR.
  const edges = [
    { src: "a", dst: "b", weight: 0.8 },
    { src: "b", dst: "c", weight: 0.8 },
    { src: "c", dst: "a", weight: 0.8 },
    { src: "x", dst: "y", weight: 0.8 },
    { src: "y", dst: "x", weight: 0.8 },
    { src: "a", dst: "x", weight: 0.8 },
  ];
  const sectors = new Map([
    ["a", "ai"], ["b", "ai"], ["c", "ai"],
    ["x", "fintech"], ["y", "fintech"],
  ]);
  const r = computeInfluence(edges, sectors);
  assert.equal(r.sectors_ranked, 2);
  const a = r.rows.find((x) => x.entity_id === "a");
  assert.ok(a.sector_pagerank_json);
  const sectorMap = JSON.parse(a.sector_pagerank_json);
  // 'a' is in 'ai' only; must not appear under 'fintech'.
  assert.ok(sectorMap.ai > 0);
  assert.equal(sectorMap.fintech, undefined);
});

test("computeInfluence: power-node top-N caps the flagged set per sector", () => {
  // 5 nodes in one sector, top-2 only should be flagged.
  const edges = [];
  for (let i = 0; i < 5; i++) {
    edges.push({ src: `s${i}`, dst: "hub", weight: 1 });
  }
  const sectors = new Map([
    ["s0", "ai"], ["s1", "ai"], ["s2", "ai"], ["s3", "ai"], ["s4", "ai"], ["hub", "ai"],
  ]);
  const r = computeInfluence(edges, sectors, { powerTopN: 2 });
  const power = r.rows.filter((x) => x.is_power_node === 1);
  assert.ok(power.length <= 2, `expected at most 2 power nodes, got ${power.length}`);
  assert.equal(r.power_nodes, power.length);
});

test("computeInfluence: nodes without a sector are ignored by per-sector pass but still get global PR + degrees", () => {
  const edges = [
    { src: "a", dst: "b", weight: 0.5 },
    { src: "b", dst: "c", weight: 0.5 },
  ];
  const sectors = new Map([["a", "ai"], ["b", "ai"]]);  // c has no sector
  const r = computeInfluence(edges, sectors);
  const c = r.rows.find((x) => x.entity_id === "c");
  assert.equal(c.primary_sector, null);
  assert.equal(c.sector_pagerank_json, null);
  assert.equal(c.is_power_node, 0);
  assert.ok(c.pagerank_score > 0, "global PR should still cover unsectored nodes");
  assert.equal(c.in_degree, 1);
});

test("computeInfluence: node-cap guardrail skips broker + per-sector PR but still emits global PR", () => {
  // Tiny graph but nodeCap=2 forces truncation.
  const edges = [
    { src: "a", dst: "b", weight: 1 },
    { src: "b", dst: "c", weight: 1 },
    { src: "c", dst: "a", weight: 1 },
  ];
  const sectors = new Map([["a", "ai"], ["b", "ai"], ["c", "ai"]]);
  const r = computeInfluence(edges, sectors, { nodeCap: 2 });
  assert.equal(r.truncated_for_size, true);
  assert.ok(r.truncation_reasons.some((s) => s.startsWith("node_cap_exceeded")));
  assert.equal(r.sectors_ranked, 0);
  assert.equal(r.power_nodes, 0);
  for (const row of r.rows) {
    assert.equal(row.broker_score, 0);
    assert.equal(row.sector_pagerank_json, null);
    assert.equal(row.is_power_node, 0);
    assert.ok(row.pagerank_score > 0, "global PR must still run under truncation");
    assert.ok(row.total_degree >= 0);
  }
});

test("computeInfluence: edge-cap guardrail also triggers truncation", () => {
  const edges = [
    { src: "a", dst: "b", weight: 1 },
    { src: "b", dst: "c", weight: 1 },
  ];
  const r = computeInfluence(edges, new Map(), { edgeCap: 1 });
  assert.equal(r.truncated_for_size, true);
  assert.ok(r.truncation_reasons.some((s) => s.startsWith("edge_cap_exceeded")));
});

test("computeInfluence: sectors with only 1 node are skipped (need ≥2 for PR)", () => {
  const edges = [
    { src: "a", dst: "b", weight: 1 },
    { src: "b", dst: "a", weight: 1 },
  ];
  // 'b' is the only fintech node — that sector should be skipped.
  const sectors = new Map([["a", "ai"], ["b", "fintech"]]);
  const r = computeInfluence(edges, sectors);
  assert.equal(r.sectors_ranked, 0);
  assert.equal(r.power_nodes, 0);
});

test("computeInfluence: emits one row per node touched by an edge", () => {
  const edges = [
    { src: "a", dst: "b", weight: 1 },
    { src: "b", dst: "c", weight: 1 },
    { src: "c", dst: "d", weight: 1 },
  ];
  const r = computeInfluence(edges, new Map());
  const ids = new Set(r.rows.map((x) => x.entity_id));
  assert.deepEqual([...ids].sort(), ["a", "b", "c", "d"]);
});
