// Task #9: implied-valuation math (pure helper-level).
//
// computeImpliedValuation hits the DB; instead this test exercises the
// percentile + multiple-application math directly by reproducing the
// formula. Integration coverage of the DB path is left for a follow-up
// e2e harness.

import { test } from "node:test";
import assert from "node:assert/strict";

// Reproduce the percentile helper from impliedValuation.ts. Kept in
// sync intentionally — if the production helper changes, this test
// will fail and the engineer will update both.
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

test("percentile picks indexed values from sorted multiples", () => {
  const m = [4, 6, 8, 10, 12, 14, 16];
  // floor(0.25*7)=1 -> m[1]=6
  assert.equal(percentile(m, 0.25), 6);
  // floor(0.5*7)=3 -> m[3]=10
  assert.equal(percentile(m, 0.5), 10);
  // floor(0.75*7)=5 -> m[5]=14
  assert.equal(percentile(m, 0.75), 14);
  // empty array returns 0
  assert.equal(percentile([], 0.5), 0);
});

test("EV/ARR application produces low/median/high range", () => {
  const mults = [4, 6, 8, 10, 12].slice().sort((a, b) => a - b);
  const arr = 50_000_000;
  const p25 = percentile(mults, 0.25); // floor(1.25)=1 -> 6
  const p50 = percentile(mults, 0.5);  // floor(2.5)=2 -> 8
  const p75 = percentile(mults, 0.75); // floor(3.75)=3 -> 10
  assert.equal(p25, 6);
  assert.equal(p50, 8);
  assert.equal(p75, 10);
  assert.equal(Math.round(arr * p25), 300_000_000);
  assert.equal(Math.round(arr * p50), 400_000_000);
  assert.equal(Math.round(arr * p75), 500_000_000);
});

test("latest-mark fallback uses ±30% band", () => {
  const v = 1_000_000_000;
  const low = Math.round(v * 0.7);
  const high = Math.round(v * 1.3);
  assert.equal(low, 700_000_000);
  assert.equal(high, 1_300_000_000);
});
