// Retrain ingestion semantics: every label-bearing intro_outcomes row
// must reach the training set. A single path with multiple outcomes
// (requested → accepted → deal_closed) should contribute multiple
// training samples — NOT collapse to the latest status only.

import { test } from "node:test";
import assert from "node:assert/strict";

const t = await import("../../../../test-dist/services/intros/train.js");

const F = { path_length: 2, weakest_eq: 0.5, target_pr: 0.3, broker_in_path: 0, ask_match: 0.2 };
const FJSON = JSON.stringify(F);

test("rowsToTrainingSamples: multiple outcomes per path each yield a sample", () => {
  // path p1 has 3 outcomes (requested dropped, accepted=1, deal_closed=1)
  // path p2 has 2 outcomes (ghosted=0, declined=0)
  const rows = [
    { features_json: FJSON, status: "requested" },     // dropped (in-flight)
    { features_json: FJSON, status: "accepted" },      // label=1
    { features_json: FJSON, status: "deal_closed" },   // label=1
    { features_json: FJSON, status: "ghosted" },       // label=0
    { features_json: FJSON, status: "declined" },      // label=0
  ];
  const samples = t.rowsToTrainingSamples(rows);
  assert.equal(samples.length, 4, "every label-bearing row contributes a sample");
  const positives = samples.filter((s) => s.label === 1).length;
  const negatives = samples.filter((s) => s.label === 0).length;
  assert.equal(positives, 2);
  assert.equal(negatives, 2);
});

test("rowsToTrainingSamples: drops in-flight statuses (requested, made)", () => {
  const rows = [
    { features_json: FJSON, status: "requested" },
    { features_json: FJSON, status: "made" },
  ];
  assert.equal(t.rowsToTrainingSamples(rows).length, 0);
});

test("rowsToTrainingSamples: drops rows with missing features_json or status", () => {
  const rows = [
    { features_json: null, status: "accepted" },
    { features_json: FJSON, status: null },
    { features_json: FJSON, status: "" },
    { features_json: FJSON, status: "accepted" },
  ];
  assert.equal(t.rowsToTrainingSamples(rows).length, 1);
});

test("rowsToTrainingSamples: drops rows with malformed features_json", () => {
  const rows = [
    { features_json: "not-json", status: "accepted" },
    { features_json: FJSON, status: "accepted" },
  ];
  assert.equal(t.rowsToTrainingSamples(rows).length, 1);
});

test("rowsToTrainingSamples: order preserved from input", () => {
  const rows = [
    { features_json: FJSON, status: "accepted" },
    { features_json: FJSON, status: "ghosted" },
    { features_json: FJSON, status: "deal_closed" },
  ];
  const s = t.rowsToTrainingSamples(rows);
  assert.deepEqual(s.map((x) => x.label), [1, 0, 1]);
});
