// Regression guard for the zero-cap bug.
//
// `checkBudget` treats a daily cap of 0 as "disabled" — a deliberate kill
// switch for metered providers. When every paid provider was removed, the
// two survivors (sec_edgar, twitter_oss) were both free AND both defaulted
// to a cap of 0, so `enrichLead` refused every call with reason:"budget"
// and the whole lead-enrichment path became a silent no-op.
//
// The fix marks free providers with `isFree`, and the orchestrator skips the
// spend gate for them. These tests pin both halves so the trap cannot be
// reset by adding a provider that reports no cost and no cap.

import { test } from "node:test";
import assert from "node:assert/strict";

const { checkBudget } = await import("../test-dist/enrichment/budget.js");
const { ALL_PROVIDERS } = await import("../test-dist/enrichment/providers/index.js");

function mockDb(spent = 0) {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => ({ cost_usd: spent }) }),
    }),
  };
}

// ---- checkBudget semantics are unchanged for metered providers ----------

test("checkBudget: cap 0 still disables a metered provider", async () => {
  const r = await checkBudget(mockDb(0), "paid_thing", 0);
  assert.equal(r.allowed, false);
});

test("checkBudget: spend at or over the cap blocks", async () => {
  assert.equal((await checkBudget(mockDb(5), "paid_thing", 5)).allowed, false);
  assert.equal((await checkBudget(mockDb(6), "paid_thing", 5)).allowed, false);
});

test("checkBudget: spend under the cap allows", async () => {
  const r = await checkBudget(mockDb(1), "paid_thing", 5);
  assert.equal(r.allowed, true);
  assert.equal(r.spent, 1);
});

// ---- the invariant that actually broke ---------------------------------

test("every zero-cap provider is declared free", () => {
  const env = {};
  const trapped = ALL_PROVIDERS.filter(
    (p) => p.dailyCapUsd(env) === 0 && p.isFree !== true,
  ).map((p) => p.name);

  assert.deepEqual(
    trapped,
    [],
    `these providers default to a daily cap of 0 without isFree, so checkBudget ` +
      `will refuse every call with reason:"budget": ${trapped.join(", ")}. ` +
      `Either give the provider a real cap or mark it isFree.`,
  );
});

test("the two shipped providers are free and always configured", () => {
  const byName = new Map(ALL_PROVIDERS.map((p) => [p.name, p]));
  for (const name of ["sec_edgar", "twitter_oss"]) {
    const p = byName.get(name);
    assert.ok(p, `${name} missing from ALL_PROVIDERS`);
    assert.equal(p.isFree, true, `${name} uses a free public API`);
    assert.equal(p.isConfigured({}), true, `${name} needs no key`);
  }
});
