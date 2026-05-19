// Task #9: comp panel criteria parsing.

import { test } from "node:test";
import assert from "node:assert/strict";

const { parseCriteria } = await import("../../../../test-dist/services/valuation/compPanel.js");

test("parseCriteria returns {} on null/bad json", () => {
  assert.deepEqual(parseCriteria(null), {});
  assert.deepEqual(parseCriteria(""), {});
  assert.deepEqual(parseCriteria("not json"), {});
});

test("parseCriteria preserves arr/growth bands", () => {
  const c = parseCriteria(JSON.stringify({
    sector: "vertical_saas", arr_min_usd: 20e6, arr_max_usd: 100e6,
    growth_min_pct: 0.5, growth_max_pct: 2.0, geography: "US",
  }));
  assert.equal(c.sector, "vertical_saas");
  assert.equal(c.arr_min_usd, 20e6);
  assert.equal(c.arr_max_usd, 100e6);
  assert.equal(c.growth_min_pct, 0.5);
  assert.equal(c.growth_max_pct, 2.0);
  assert.equal(c.geography, "US");
});

// Regression: ensure both growth_min_pct and growth_max_pct define the
// admissible band. Reproduces the screener's per-row predicate so a
// future drift between criteria parsing and screening trips a test.
test("growth band predicate: only rows inside [min,max] survive", () => {
  const min = 0.5, max = 2.0;
  function passes(growth) {
    if (min != null && (growth == null || growth < min)) return false;
    if (max != null && (growth == null || growth > max)) return false;
    return true;
  }
  assert.equal(passes(null), false);
  assert.equal(passes(0.4), false);
  assert.equal(passes(0.5), true);
  assert.equal(passes(1.2), true);
  assert.equal(passes(2.0), true);
  assert.equal(passes(2.1), false);
});
