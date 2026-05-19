// Task #2: Fund-Return Modeling — pure-layer tests.
//
// Covers the pure modules (proceeds estimator, confidence scoring,
// fee drag, ownership estimation). DB-bound paths (runFundReturnModel,
// rebuildCalibration, route handlers) are integration-tested via the
// worker test harness.

import { test } from "node:test";
import assert from "node:assert/strict";

const { estimateProceeds, scoreConfidence, computeFeeDrag, estimateOwnership } =
  await import("../../../../test-dist/services/fundReturns/proceeds.js");

test("estimateProceeds: IPO with offer + retained applies VWAP fallback", () => {
  const est = estimateProceeds({
    company_entity_id: "c1",
    company_name: "Acme",
    position_usd: 10_000_000,
    ownership_pct: 0.10,
    exit: {
      event_kind: "ipo",
      event_date: "2024-04-01",
      ipo_offer_price_usd: 20,
      ipo_shares_sold: 5_000_000,
      ipo_retained_shares: 2_000_000,
      vwap_180d_usd: 30,
      source_url: "https://sec.gov/x",
    },
  });
  // ownership × (5M × $20 + 2M × $30) = 0.10 × (100M + 60M) = 16M
  assert.equal(est.realized_usd, 16_000_000);
  assert.equal(est.residual_usd, 0);
  assert.equal(est.event_kind, "ipo");
  assert.ok(est.confidence >= 0.8);
});

test("estimateProceeds: IPO missing share counts falls back to valuation", () => {
  const est = estimateProceeds({
    company_entity_id: "c1",
    company_name: "Acme",
    position_usd: 5_000_000,
    ownership_pct: 0.10,
    exit: {
      event_kind: "ipo",
      event_date: "2024-04-01",
      last_mark_valuation_usd: 1_000_000_000,
      source_url: null,
    },
  });
  // ownership × valuation = 0.10 × 1B = 100M
  assert.equal(est.realized_usd, 100_000_000);
  assert.ok(est.notes.includes("ipo_used_valuation_fallback"));
});

test("estimateProceeds: M&A applies escrow haircut", () => {
  const est = estimateProceeds({
    company_entity_id: "c1",
    company_name: "Acme",
    position_usd: 5_000_000,
    ownership_pct: 0.20,
    exit: {
      event_kind: "acquisition",
      event_date: "2024-06-01",
      ma_deal_size_usd: 500_000_000,
      ma_escrow_pct: 0.10,
      source_url: "https://sec.gov/8k",
    },
  });
  // 0.20 × 500M × 0.90 = 90M
  assert.equal(est.realized_usd, 90_000_000);
  assert.equal(est.residual_usd, 0);
});

test("estimateProceeds: M&A undisclosed → sector multiple fallback", () => {
  const est = estimateProceeds({
    company_entity_id: "c1",
    company_name: "Acme",
    position_usd: 5_000_000,
    ownership_pct: 0.15,
    exit: {
      event_kind: "acquisition",
      event_date: "2024-06-01",
      ma_inferred_revenue_usd: 50_000_000,
      ma_sector_median_multiple: 8,
      source_url: null,
    },
  });
  // 0.15 × (50M × 8) × (1 − 0) = 60M
  assert.equal(est.realized_usd, 60_000_000);
  assert.ok(est.notes.includes("ma_used_sector_median_multiple"));
  assert.ok(est.confidence < 0.7);
});

test("estimateProceeds: bankruptcy returns 0 / 0", () => {
  const est = estimateProceeds({
    company_entity_id: "c1",
    company_name: "Acme",
    position_usd: 5_000_000,
    ownership_pct: 0.10,
    exit: { event_kind: "bankruptcy", event_date: "2024-03-01", source_url: "https://courts" },
  });
  assert.equal(est.realized_usd, 0);
  assert.equal(est.residual_usd, 0);
});

test("estimateProceeds: unexited uses last mark × ownership", () => {
  const est = estimateProceeds({
    company_entity_id: "c1",
    company_name: "Acme",
    position_usd: 5_000_000,
    ownership_pct: 0.10,
    exit: { event_kind: "unexited", event_date: "2024-09-01", last_mark_valuation_usd: 800_000_000 },
  });
  assert.equal(est.realized_usd, 0);
  assert.equal(est.residual_usd, 80_000_000);
});

test("estimateProceeds: no exit signal held at cost", () => {
  const est = estimateProceeds({
    company_entity_id: null,
    company_name: "Beta",
    position_usd: 3_000_000,
    ownership_pct: 0.08,
    exit: null,
  });
  assert.equal(est.realized_usd, 0);
  assert.equal(est.residual_usd, 3_000_000);
  assert.ok(est.notes.some((n) => n.includes("held_at_cost")));
});

test("estimateProceeds: defaults ownership to 5% with note", () => {
  const est = estimateProceeds({
    company_entity_id: "c1",
    company_name: "Acme",
    position_usd: 1_000_000,
    ownership_pct: null,
    exit: { event_kind: "acquisition", ma_deal_size_usd: 100_000_000, ma_escrow_pct: 0, event_date: null, source_url: null },
  });
  assert.equal(est.realized_usd, 5_000_000);  // 5% × 100M
  assert.ok(est.notes.includes("ownership_defaulted_to_5pct"));
});

test("scoreConfidence: ≥70% resolved → high", () => {
  assert.equal(scoreConfidence(10, 7), "high");
  assert.equal(scoreConfidence(10, 10), "high");
});
test("scoreConfidence: 40–70% → medium", () => {
  assert.equal(scoreConfidence(10, 5), "medium");
  assert.equal(scoreConfidence(10, 4), "medium");
});
test("scoreConfidence: <40% → low", () => {
  assert.equal(scoreConfidence(10, 3), "low");
  assert.equal(scoreConfidence(10, 0), "low");
  assert.equal(scoreConfidence(0, 0), "low");
});

test("computeFeeDrag: 2%/yr × years × committed, capped at 10y", () => {
  // 5 years × 2% × 100M = 10M
  const d = computeFeeDrag(100_000_000, "2019-01-01", "2024-01-01", 0.02);
  assert.ok(d > 9_900_000 && d < 10_100_000);
});
test("computeFeeDrag: caps at 10 years", () => {
  const d = computeFeeDrag(100_000_000, "2000-01-01", "2030-01-01", 0.02);
  assert.equal(d, 100_000_000 * 0.02 * 10);  // 20M
});
test("computeFeeDrag: missing inputs → 0", () => {
  assert.equal(computeFeeDrag(null, "2020-01-01", "2024-01-01"), 0);
  assert.equal(computeFeeDrag(100_000_000, null, "2024-01-01"), 0);
});

test("estimateOwnership: clamps to [0.1%, 50%]", () => {
  assert.equal(estimateOwnership(10_000_000, 100_000_000), 0.1);
  // Huge check → clamped to 50%
  assert.equal(estimateOwnership(900_000_000, 1_000_000_000), 0.5);
  // Tiny check → clamped to 0.1%
  assert.equal(estimateOwnership(100, 1_000_000_000), 0.001);
});
test("estimateOwnership: returns null when inputs missing", () => {
  assert.equal(estimateOwnership(null, 100_000_000), null);
  assert.equal(estimateOwnership(10_000_000, null), null);
  assert.equal(estimateOwnership(10_000_000, 0), null);
});
