// Task #9: cost-formula unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCostUsd } from "../../../../test-dist/services/compute/cost.js";

test("runtime-only cost", () => {
  const c = computeCostUsd({ runtime_ms: 3_600_000, tokens_used: 0, cost_per_hour_usd: 0.4, cost_per_1k_tokens_usd: 0 });
  assert.equal(c, 0.4);
});
test("token-only cost", () => {
  const c = computeCostUsd({ runtime_ms: 0, tokens_used: 1000, cost_per_hour_usd: 0, cost_per_1k_tokens_usd: 0.002 });
  assert.equal(c, 0.002);
});
test("combined cost", () => {
  const c = computeCostUsd({ runtime_ms: 1_800_000, tokens_used: 500, cost_per_hour_usd: 0.4, cost_per_1k_tokens_usd: 0.002 });
  // 0.5h * 0.4 + 0.5k * 0.002 = 0.2 + 0.001 = 0.201
  assert.equal(c, 0.201);
});
test("negative inputs clamp to zero", () => {
  const c = computeCostUsd({ runtime_ms: -100, tokens_used: -5, cost_per_hour_usd: -1, cost_per_1k_tokens_usd: -1 });
  assert.equal(c, 0);
});
