import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classificationMetrics, pairPRF1, fieldLevelF1,
  calibrationMetrics, regressionGate,
} from "../../../../test-dist/services/mlOps/metrics.js";

test("classificationMetrics: perfect predictions → accuracy 1, f1 1", () => {
  const m = classificationMetrics([
    { predicted: "a", gold: "a" }, { predicted: "b", gold: "b" }, { predicted: "a", gold: "a" },
  ]);
  assert.equal(m.accuracy, 1);
  assert.equal(m.f1_macro, 1);
});

test("classificationMetrics: half wrong → accuracy 0.5, per-class populated", () => {
  const m = classificationMetrics([
    { predicted: "a", gold: "a" }, { predicted: "a", gold: "b" },
  ]);
  assert.equal(m.accuracy, 0.5);
  assert.ok(m.per_class.a);
  assert.ok(m.per_class.b);
});

test("classificationMetrics: empty rows → zeros (degrades cleanly)", () => {
  const m = classificationMetrics([]);
  assert.equal(m.accuracy, 0);
  assert.equal(m.f1_macro, 0);
});

test("pairPRF1: TP/FP/FN/TN counted correctly", () => {
  const m = pairPRF1([
    { predicted: true,  gold: true  }, // tp
    { predicted: true,  gold: false }, // fp
    { predicted: false, gold: true  }, // fn
    { predicted: false, gold: false }, // tn
  ]);
  assert.equal(m.tp, 1); assert.equal(m.fp, 1);
  assert.equal(m.fn, 1); assert.equal(m.tn, 1);
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  assert.equal(m.f1, 0.5);
});

test("fieldLevelF1: field counted as TP only on deep-equal non-empty match", () => {
  const m = fieldLevelF1([
    { predicted: { a: "X", b: 1 }, gold: { a: "X", b: 2 } },
    { predicted: { a: "Y" },       gold: { a: "Y", b: 9 } },
  ]);
  // field a: 2 tp; field b: 0 tp, 1 fp+1 fn (mismatch) + 1 fn (missing)
  assert.ok(m.per_field.a);
  assert.equal(m.per_field.a.precision, 1);
  assert.ok(m.per_field.b);
  assert.ok(m.precision > 0 && m.precision < 1);
});

test("calibrationMetrics: perfect predictions → brier 0", () => {
  const m = calibrationMetrics([
    { predicted: 1, actual: 1 }, { predicted: 0, actual: 0 },
  ]);
  assert.ok(m.brier < 1e-6);
  assert.equal(m.n, 2);
});

test("calibrationMetrics: random 0.5 → brier 0.25", () => {
  const m = calibrationMetrics([
    { predicted: 0.5, actual: 1 }, { predicted: 0.5, actual: 0 },
  ]);
  assert.ok(Math.abs(m.brier - 0.25) < 1e-9);
});

test("regressionGate: no previous → pass", () => {
  const r = regressionGate(null, { f1: 0.5 });
  assert.equal(r.passed, true);
});

test("regressionGate: 6% drop > 5% threshold → fail", () => {
  const r = regressionGate({ f1: 1.0 }, { f1: 0.93 }, 5);
  assert.equal(r.passed, false);
  assert.equal(r.regressions[0].metric, "f1");
});

test("regressionGate: 4% drop < 5% threshold → pass", () => {
  const r = regressionGate({ f1: 1.0 }, { f1: 0.96 }, 5);
  assert.equal(r.passed, true);
});

test("regressionGate: brier rising > 5% → fail (lower is better)", () => {
  const r = regressionGate({ brier: 0.10 }, { brier: 0.12 }, 5);
  assert.equal(r.passed, false);
  assert.equal(r.regressions[0].metric, "brier");
});
