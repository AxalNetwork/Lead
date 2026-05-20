// Task #6: overall-score aggregator + re-run-failed filter tests.
import { test } from "node:test";
import assert from "node:assert/strict";

const { computeOverallScore, tallyByStatus, isFailLike } =
  await import("../../../../test-dist/services/diligence/score.js");

test("computeOverallScore — empty input is 0", () => {
  assert.equal(computeOverallScore([]), 0);
});

test("computeOverallScore — all pass yields 100", () => {
  const r = [
    { status: "pass", severity: "high" },
    { status: "pass", severity: "low" },
    { status: "pass", severity: "critical" },
  ];
  assert.equal(computeOverallScore(r), 100);
});

test("computeOverallScore — n/a treated as full credit", () => {
  const r = [
    { status: "pass", severity: "low" },
    { status: "n/a",  severity: "low" },
  ];
  assert.equal(computeOverallScore(r), 100);
});

test("computeOverallScore — severity weights matter (critical fail >> low fail)", () => {
  const lowFail = computeOverallScore([{ status: "pass", severity: "low" }, { status: "fail", severity: "low" }]);
  const critFail = computeOverallScore([{ status: "pass", severity: "low" }, { status: "fail", severity: "critical" }]);
  assert.ok(critFail < lowFail, `critical fail (${critFail}) should be < low fail (${lowFail})`);
});

test("computeOverallScore — needs_human is half credit", () => {
  const r = [{ status: "needs_human", severity: "low" }];
  assert.equal(computeOverallScore(r), 50);
});

test("computeOverallScore — caution is 60% credit", () => {
  const r = [{ status: "caution", severity: "low" }];
  assert.equal(computeOverallScore(r), 60);
});

test("tallyByStatus — counts each bucket", () => {
  const t = tallyByStatus([
    { status: "pass", severity: "low" },
    { status: "pass", severity: "low" },
    { status: "fail", severity: "low" },
    { status: "caution", severity: "low" },
    { status: "n/a", severity: "low" },
    { status: "needs_human", severity: "low" },
  ]);
  assert.deepEqual(t, { pass: 2, fail: 1, caution: 1, "n/a": 1, needs_human: 1 });
});

test("isFailLike — fail, caution, needs_human all true; pass + n/a false", () => {
  assert.equal(isFailLike({ status: "fail" }), true);
  assert.equal(isFailLike({ status: "caution" }), true);
  assert.equal(isFailLike({ status: "needs_human" }), true);
  assert.equal(isFailLike({ status: "pass" }), false);
  assert.equal(isFailLike({ status: "n/a" }), false);
});
