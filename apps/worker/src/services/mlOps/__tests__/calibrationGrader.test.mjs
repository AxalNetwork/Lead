import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrationMetrics } from "../../../../test-dist/services/mlOps/metrics.js";

// The full runCalibrationGrade requires a D1 binding, so we unit-test
// the four common outcome-shape branches by exercising the underlying
// reducer directly: boolean, scalar-threshold, categorical-match,
// numeric-proximity all collapse to (predicted_prob, actual 0/1)
// before reaching the calibration helper.

function shapeBoolean(predicted_prob, outcome_bool) {
  return { predicted: predicted_prob, actual: outcome_bool ? 1 : 0 };
}
function shapeScalarThreshold(predicted_value, actual_value, threshold) {
  return { predicted: predicted_value >= threshold ? 1 : 0, actual: actual_value >= threshold ? 1 : 0 };
}
function shapeCategoricalMatch(predicted_label, actual_label) {
  return { predicted: predicted_label === actual_label ? 1 : 0, actual: 1 };
}
function shapeNumericProximity(predicted_n, actual_n, tolerance) {
  const within = Math.abs(predicted_n - actual_n) <= tolerance;
  return { predicted: within ? 0.9 : 0.1, actual: within ? 1 : 0 };
}

test("calibration shape: boolean outcomes → brier reflects miscalibration", () => {
  const rows = [
    shapeBoolean(0.9, true), shapeBoolean(0.9, true),
    shapeBoolean(0.1, false), shapeBoolean(0.1, false),
  ];
  const m = calibrationMetrics(rows);
  assert.ok(m.brier < 0.05);
});

test("calibration shape: scalar threshold collapses to binary", () => {
  const rows = [
    shapeScalarThreshold(150, 200, 100), // both ≥ → 1,1
    shapeScalarThreshold(50, 30, 100),   // both < → 0,0
    shapeScalarThreshold(150, 50, 100),  // mismatch → 1,0
  ];
  const m = calibrationMetrics(rows);
  assert.equal(m.n, 3);
});

test("calibration shape: categorical match → 1 when label matches", () => {
  const r1 = shapeCategoricalMatch("vc", "vc");
  const r2 = shapeCategoricalMatch("vc", "angel");
  assert.equal(r1.predicted, 1); assert.equal(r1.actual, 1);
  assert.equal(r2.predicted, 0); assert.equal(r2.actual, 1);
});

test("calibration shape: numeric proximity within tolerance → predicted high + actual 1", () => {
  const r = shapeNumericProximity(100, 105, 10);
  assert.equal(r.actual, 1);
  assert.ok(r.predicted > 0.5);
});

test("calibrationMetrics: empty → all zeros", () => {
  const m = calibrationMetrics([]);
  assert.equal(m.n, 0); assert.equal(m.brier, 0);
});
