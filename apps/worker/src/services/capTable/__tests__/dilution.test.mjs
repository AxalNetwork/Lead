// Task #5: dilution waterfall unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";

const { buildDilutionWaterfall } = await import("../../../../test-dist/services/capTable/dilution.js");

test("buildDilutionWaterfall computes per-holder pct_change between two snapshots", () => {
  const A = {
    id: "snap-a", as_of: "2023-01-01", source_kind: "form_d_inference",
    fully_diluted_shares: 100, post_money_usd: 100_000_000,
    option_pool_pct: 0.10, preferred_pct: 0.40, common_pct: 0.50, confidence: 0.55,
    holders: [
      { holder_name_normalized: "sequoia", holder_name_raw: "Sequoia", holder_entity_id: "e-seq",
        holder_class: "preferred_investor", security_type: "preferred_a", shares: 40, pct_ownership: 0.40, round_acquired: "Series A" },
      { holder_name_normalized: "founder", holder_name_raw: "Founder", holder_entity_id: "e-f",
        holder_class: "founder", security_type: "common", shares: 50, pct_ownership: 0.50, round_acquired: "Founder Grant" },
    ],
  };
  const B = {
    id: "snap-b", as_of: "2024-06-01", source_kind: "s1_filing",
    fully_diluted_shares: 200, post_money_usd: 500_000_000,
    option_pool_pct: 0.15, preferred_pct: 0.55, common_pct: 0.30, confidence: 0.95,
    holders: [
      { holder_name_normalized: "sequoia", holder_name_raw: "Sequoia", holder_entity_id: "e-seq",
        holder_class: "preferred_investor", security_type: "preferred_a", shares: 40, pct_ownership: 0.20, round_acquired: "Series A" },
      { holder_name_normalized: "a16z", holder_name_raw: "Andreessen Horowitz", holder_entity_id: "e-a16z",
        holder_class: "preferred_investor", security_type: "preferred_b", shares: 70, pct_ownership: 0.35, round_acquired: "Series B" },
      { holder_name_normalized: "founder", holder_name_raw: "Founder", holder_entity_id: "e-f",
        holder_class: "founder", security_type: "common", shares: 60, pct_ownership: 0.30, round_acquired: "Founder Grant" },
    ],
  };
  const steps = buildDilutionWaterfall([B, A]); // out-of-order on input
  assert.equal(steps.length, 1);
  const step = steps[0];
  assert.equal(step.from_snapshot_id, "snap-a");
  assert.equal(step.to_snapshot_id, "snap-b");
  assert.equal(step.share_growth_ratio, 2);
  const seq = step.holders.find((h) => h.holder_entity_id === "e-seq");
  assert.ok(Math.abs(seq.pct_change + 0.20) < 1e-6, `Sequoia diluted by 20 pp, got ${seq.pct_change}`);
  const a16z = step.holders.find((h) => h.holder_entity_id === "e-a16z");
  assert.equal(a16z.new_in_round, true);
  assert.equal(a16z.pct_after, 0.35);
});

test("buildDilutionWaterfall yields empty steps for a single snapshot", () => {
  const A = {
    id: "snap-a", as_of: "2023-01-01", source_kind: "s1_filing",
    fully_diluted_shares: 100, post_money_usd: null,
    option_pool_pct: null, preferred_pct: null, common_pct: null, confidence: 0.95,
    holders: [],
  };
  assert.deepEqual(buildDilutionWaterfall([A]), []);
});
