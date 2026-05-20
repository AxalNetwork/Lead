import { test } from "node:test";
import assert from "node:assert/strict";
import { fnv1a32, shouldRouteToNew } from "../../../../test-dist/services/mlOps/abRouting.js";

test("fnv1a32: deterministic + non-zero for non-empty input", () => {
  assert.equal(fnv1a32("hello"), fnv1a32("hello"));
  assert.notEqual(fnv1a32("hello"), fnv1a32("world"));
});

test("shouldRouteToNew: 100% rollout always routes new", () => {
  for (let i = 0; i < 25; i++) {
    assert.equal(shouldRouteToNew("k", "salt-" + i, 100), true);
  }
});

test("shouldRouteToNew: 0% rollout never routes new", () => {
  for (let i = 0; i < 25; i++) {
    assert.equal(shouldRouteToNew("k", "salt-" + i, 0), false);
  }
});

test("shouldRouteToNew: 10% rollout buckets ~10% of a wide salt range", () => {
  let yes = 0;
  for (let i = 0; i < 1000; i++) {
    if (shouldRouteToNew("prompt-key", "entity-" + i, 10)) yes += 1;
  }
  // Loose check: should be around 100, allow [50, 200]
  assert.ok(yes > 50 && yes < 200, `expected ~10%, got ${yes}/1000`);
});

test("shouldRouteToNew: identical inputs are stable across calls", () => {
  const a = shouldRouteToNew("k", "e-7", 50);
  const b = shouldRouteToNew("k", "e-7", 50);
  assert.equal(a, b);
});
