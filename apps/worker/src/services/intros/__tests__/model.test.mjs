import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("../../../../test-dist/services/intros/model.js");

const F0 = { path_length: 1, weakest_eq: 0.0, target_pr: 0.0, broker_in_path: 0, ask_match: 0 };
const F_GOOD = { path_length: 1, weakest_eq: 0.9, target_pr: 0.8, broker_in_path: 1, ask_match: 1 };
const F_BAD  = { path_length: 3, weakest_eq: 0.05, target_pr: 0.0, broker_in_path: 0, ask_match: 0 };

test("sigmoid: maps z=0 → 0.5, extremes saturate", () => {
  assert.equal(m.sigmoid(0), 0.5);
  assert.equal(m.sigmoid(100), 1);
  assert.equal(m.sigmoid(-100), 0);
});

test("predict: default weights, all-zero features → below 0.5", () => {
  const p = m.predict(m.DEFAULT_WEIGHTS, F0);
  assert.ok(p > 0 && p < 0.5);
});

test("predict: good path scores higher than bad path", () => {
  const good = m.predict(m.DEFAULT_WEIGHTS, F_GOOD);
  const bad  = m.predict(m.DEFAULT_WEIGHTS, F_BAD);
  assert.ok(good > bad, `expected good (${good}) > bad (${bad})`);
});

test("predict: returns probability in [0,1]", () => {
  for (const f of [F0, F_GOOD, F_BAD]) {
    const p = m.predict(m.DEFAULT_WEIGHTS, f);
    assert.ok(p >= 0 && p <= 1);
  }
});

test("outcomeToLabel: positive/negative/drop mapping", () => {
  for (const s of ["accepted", "meeting_held", "deal_closed"]) assert.equal(m.outcomeToLabel(s), 1);
  for (const s of ["declined", "ghosted"]) assert.equal(m.outcomeToLabel(s), 0);
  for (const s of ["requested", "made", "unknown_status"]) assert.equal(m.outcomeToLabel(s), null);
});

test("trainLogistic: insufficient samples → returns init weights unchanged", () => {
  const samples = [
    { features: F_GOOD, label: 1 },
    { features: F_BAD, label: 0 },
  ];
  const r = m.trainLogistic(samples);
  assert.deepEqual(r.weights, m.DEFAULT_WEIGHTS);
  assert.equal(r.sample_size, 2);
});

test("trainLogistic: degenerate (all same class) → returns init unchanged", () => {
  const samples = Array.from({ length: 40 }, () => ({ features: F_GOOD, label: 1 }));
  const r = m.trainLogistic(samples);
  assert.deepEqual(r.weights, m.DEFAULT_WEIGHTS);
  assert.equal(r.positives, 40);
  assert.equal(r.negatives, 0);
});

test("trainLogistic: learns to separate good vs bad on a balanced dataset", () => {
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ features: F_GOOD, label: 1 });
  for (let i = 0; i < 20; i++) samples.push({ features: F_BAD, label: 0 });
  const r = m.trainLogistic(samples);
  assert.equal(r.sample_size, 40);
  const pGood = m.predict(r.weights, F_GOOD);
  const pBad  = m.predict(r.weights, F_BAD);
  assert.ok(pGood > 0.7, `expected pGood > 0.7, got ${pGood}`);
  assert.ok(pBad < 0.3, `expected pBad < 0.3, got ${pBad}`);
  assert.ok(r.brier < m.brierScore(m.DEFAULT_WEIGHTS, samples), "Brier should improve over priors");
});

test("brierScore: perfect predictions → 0", () => {
  // Hand-craft weights that classify F_GOOD/F_BAD perfectly via huge intercept on weakest_eq.
  const samples = [
    { features: F_GOOD, label: 1 },
    { features: F_BAD, label: 0 },
  ];
  const w = { intercept: -5, length: 0, weakest_eq: 20, target_pr: 0, broker: 0, ask_match: 0 };
  const b = m.brierScore(w, samples);
  assert.ok(b < 0.05);
});

test("brierScore: empty samples → 0", () => {
  assert.equal(m.brierScore(m.DEFAULT_WEIGHTS, []), 0);
});
