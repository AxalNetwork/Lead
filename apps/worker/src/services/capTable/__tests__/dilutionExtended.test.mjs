// Task #5: extended dilution tests — event-stream merge + trajectory projection.

import { test } from "node:test";
import assert from "node:assert/strict";

const { mergeDealEventsIntoTimeline, projectTrajectory, buildDilutionWaterfall } =
  await import("../../../../test-dist/services/capTable/dilution.js");

function snap(id, as_of, post, fd, holders = [], confidence = 0.55) {
  return {
    id, as_of, source_kind: "form_d_inference", fully_diluted_shares: fd, post_money_usd: post,
    option_pool_pct: 0.12, preferred_pct: 0.40, common_pct: 0.45, confidence, holders,
  };
}

test("mergeDealEventsIntoTimeline promotes deals without nearby snapshots", () => {
  const snaps = [snap("s1", "2022-01-01", 50_000_000, 50)];
  const deals = [
    { id: "d1", as_of: "2023-06-01", round_name: "Series C", amount_usd: 30_000_000, valuation_usd: 200_000_000, sector_tag: "saas" },
    { id: "d2", as_of: "2022-01-15", round_name: "Seed", amount_usd: 5_000_000, valuation_usd: 55_000_000, sector_tag: "saas" }, // near s1, skipped
  ];
  const merged = mergeDealEventsIntoTimeline(snaps, deals, null);
  assert.equal(merged.length, 2, "expected exactly 1 deal merged in");
  const synth = merged.find((s) => s.id === "deal:d1");
  assert.ok(synth, "Series C deal should be promoted");
  assert.equal(synth.post_money_usd, 200_000_000);
});

test("mergeDealEventsIntoTimeline fills missing post-money from sector median", () => {
  const snaps = [snap("s1", "2022-01-01", 50_000_000, 50)];
  const deals = [{ id: "d1", as_of: "2023-06-01", round_name: "Series C", amount_usd: 30_000_000, valuation_usd: null, sector_tag: "saas" }];
  const merged = mergeDealEventsIntoTimeline(snaps, deals, 175_000_000);
  const synth = merged.find((s) => s.id === "deal:d1");
  assert.equal(synth.post_money_usd, 175_000_000);
});

test("projectTrajectory extrapolates next-step post-money + founder pct", () => {
  const founderHolder = { holder_name_normalized: "f", holder_name_raw: "Founder", holder_entity_id: "f", holder_class: "founder", security_type: "common", shares: 40, pct_ownership: 0.40, round_acquired: null };
  const snaps = [
    snap("s1", "2022-01-01", 50_000_000, 100, [{ ...founderHolder, shares: 60, pct_ownership: 0.60 }]),
    snap("s2", "2023-01-01", 150_000_000, 130, [{ ...founderHolder, shares: 60, pct_ownership: 0.46 }]),
    snap("s3", "2024-01-01", 400_000_000, 170, [{ ...founderHolder, shares: 60, pct_ownership: 0.35 }]),
  ];
  const steps = buildDilutionWaterfall(snaps);
  assert.equal(steps.length, 2);
  const proj = projectTrajectory(steps, 12);
  assert.ok(proj, "expected non-null projection");
  assert.ok(proj.projected_post_money_usd && proj.projected_post_money_usd > 400_000_000,
    `projected post-money should grow, got ${proj.projected_post_money_usd}`);
  assert.ok(proj.projected_founder_pct != null && proj.projected_founder_pct < 0.35,
    `projected founder pct should keep diluting, got ${proj.projected_founder_pct}`);
  assert.equal(proj.basis_steps, 2);
});

test("projectTrajectory returns null for fewer than 2 steps", () => {
  const snaps = [snap("s1", "2022-01-01", 50_000_000, 100), snap("s2", "2023-01-01", 150_000_000, 130)];
  const steps = buildDilutionWaterfall(snaps);
  const proj = projectTrajectory(steps);
  assert.equal(proj, null);
});
