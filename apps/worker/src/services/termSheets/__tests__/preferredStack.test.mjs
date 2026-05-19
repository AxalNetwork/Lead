// Task #18: Term-Sheet Intelligence tests.
//
// Covers the three pure layers (parser strict-rules, bucketing,
// per-series scoring). DB-bound paths (upsertPreferredSeries,
// rebuildTermBenchmarks, computeInvestorAggressiveness, route
// handlers) are integration-tested via the worker test harness.

import { test } from "node:test";
import assert from "node:assert/strict";

const { extractPreferredStack } = await import("../../../../test-dist/services/termSheets/preferredSeriesParser.js");
const { bucketSeries } = await import("../../../../test-dist/services/termSheets/benchmarks.js");
const { scoreSeries } = await import("../../../../test-dist/services/termSheets/aggressiveness.js");
const { extractLeakCandidates } = await import("../../../../test-dist/services/termSheets/leakHarvester.js");

test("parser: locates Description of Capital Stock section and extracts Series B", () => {
  const html = `
    <h1>Acme Inc S-1</h1>
    <h2>DESCRIPTION OF CAPITAL STOCK</h2>
    <p>The following describes our preferred stock.</p>
    <h3>Series B Preferred Stock</h3>
    <p>The Series B Preferred Stock carries a liquidation preference of 1.5x the original issue price.
       The Series B is participating, subject to a cap of 3x. Anti-dilution adjustments are made on a
       broad-based weighted-average basis. The Series B accrues cumulative dividends at an annual rate of 8%.
       The Series B Original Issue Price is $5.00 per share. Convertible into Common Stock at a ratio of 1:1.</p>
    <h3>Series A Preferred Stock</h3>
    <p>The Series A Preferred Stock has a liquidation preference equal to the Original Issue Price (1x).
       The Series A is non-participating. Anti-dilution adjustments shall be on a narrow-based weighted-average basis.</p>
  `;
  const ex = extractPreferredStack(html, { closingDate: "2024-06-01" });
  assert.equal(ex.series.length, 2);
  const b = ex.series.find((s) => s.series_name === "Series B");
  assert.ok(b, "Series B present");
  assert.equal(b.liquidation_pref_x, 1.5);
  assert.equal(b.participating, true);
  assert.equal(b.participating_cap_x, 3);
  assert.equal(b.anti_dilution, "broad_weighted");
  assert.equal(b.dividend_rate_pct, 0.08);
  assert.equal(b.dividend_cumulative, true);
  assert.equal(b.original_issue_price_usd, 5);
  assert.equal(b.stage, "series_b");
  assert.equal(b.closing_date, "2024-06-01");

  const a = ex.series.find((s) => s.series_name === "Series A");
  assert.equal(a.liquidation_pref_x, 1);
  assert.equal(a.participating, false);
  assert.equal(a.anti_dilution, "narrow_weighted");
  assert.equal(a.stage, "series_a");
});

test("parser strict rule: participating without cap signal downgrades confidence + warns", () => {
  const html = `
    DESCRIPTION OF CAPITAL STOCK
    Series A Preferred Stock
    The Series A is participating in liquidation. Liquidation preference of 1x the original issue price.
    Anti-dilution adjustments on a broad-based weighted-average basis.
  `;
  const ex = extractPreferredStack(html);
  const a = ex.series[0];
  assert.equal(a.participating, true);
  assert.equal(a.participating_cap_x, null);
  assert.ok(a.warnings.includes("participating_cap_unknown"));
  assert.ok(a.confidence <= 0.5, "confidence downgraded when participating cap is indeterminate");
});

test("parser strict rule: uncapped participating is explicitly tagged, no cap_unknown warning", () => {
  const html = `
    DESCRIPTION OF CAPITAL STOCK
    Series C Preferred Stock
    The Series C is participating without any cap. 2x liquidation preference of original issue price.
    Full-ratchet anti-dilution protection.
  `;
  const ex = extractPreferredStack(html);
  const c = ex.series[0];
  assert.equal(c.participating, true);
  assert.equal(c.participating_cap_x, null);
  assert.ok(c.warnings.includes("participating_uncapped_explicit"));
  assert.ok(!c.warnings.includes("participating_cap_unknown"));
  assert.equal(c.anti_dilution, "full_ratchet");
  assert.equal(c.liquidation_pref_x, 2);
});

test("parser strict rule: anti-dilution stays null when no recognised phrase present", () => {
  const html = `
    DESCRIPTION OF CAPITAL STOCK
    Series Seed Preferred Stock
    Liquidation preference of 1x the original issue price. Non-participating.
  `;
  const ex = extractPreferredStack(html);
  assert.equal(ex.series[0].anti_dilution, null);
  assert.equal(ex.series[0].stage, "seed");
});

test("parser: drops series row with zero core terms (no LP/participating/anti-dilution)", () => {
  const html = `
    DESCRIPTION OF CAPITAL STOCK
    Series Z Preferred Stock
    The Series Z is governed by the Certificate of Incorporation.
  `;
  const ex = extractPreferredStack(html);
  assert.equal(ex.series.length, 0);
  assert.ok(ex.warnings.some((w) => w.startsWith("series_Z_no_core_terms")));
});

test("bucketSeries: groups by (stage, sector, year) and computes percentages", () => {
  const rows = [
    { stage: "series_a", sector: "saas", closing_date: "2024-03-01", liquidation_pref_x: 1, participating: 0, participating_cap_x: null, anti_dilution: "broad_weighted", board_total: 5 },
    { stage: "series_a", sector: "saas", closing_date: "2024-07-15", liquidation_pref_x: 1, participating: 0, participating_cap_x: null, anti_dilution: "broad_weighted", board_total: 5 },
    { stage: "series_a", sector: "saas", closing_date: "2024-11-09", liquidation_pref_x: 2, participating: 1, participating_cap_x: 2, anti_dilution: "full_ratchet", board_total: 7 },
    { stage: "series_a", sector: "saas", closing_date: "2024-12-01", liquidation_pref_x: 1, participating: 1, participating_cap_x: null, anti_dilution: "broad_weighted", board_total: 5 },
    // Different bucket
    { stage: "series_b", sector: "saas", closing_date: "2024-04-01", liquidation_pref_x: 1, participating: 0, participating_cap_x: null, anti_dilution: "narrow_weighted", board_total: 7 },
    // Excluded: no closing_date
    { stage: "series_a", sector: "saas", closing_date: null, liquidation_pref_x: 1, participating: 0, participating_cap_x: null, anti_dilution: null, board_total: 5 },
  ];
  const bench = bucketSeries(rows);
  const aSaas = bench.find((b) => b.stage === "series_a" && b.sector === "saas" && b.year === 2024);
  assert.ok(aSaas, "series_a/saas/2024 bucket present");
  assert.equal(aSaas.sample_size, 4);
  assert.equal(aSaas.pct_lp_1x, 0.75);
  assert.equal(aSaas.pct_lp_gt_1x, 0.25);
  assert.equal(aSaas.pct_participating, 0.5);
  // 2 participating: 1 capped (cap=2), 1 uncapped
  assert.equal(aSaas.pct_participating_capped, 0.5);
  assert.equal(aSaas.pct_uncapped_participating, 0.5);
  assert.equal(aSaas.pct_full_ratchet, 0.25);
  assert.equal(aSaas.pct_broad_weighted, 0.75);
  assert.equal(aSaas.median_board_size, 5);
  assert.equal(aSaas.median_lp_x, 1);

  const bSaas = bench.find((b) => b.stage === "series_b");
  assert.ok(bSaas);
  assert.equal(bSaas.sample_size, 1);
});

test("scoreSeries: full-ratchet + uncapped-participating + 2x LP scores high", () => {
  const r = scoreSeries({
    id: "x", series_name: "Series A", company_entity_id: "c",
    liquidation_pref_x: 2, participating: 1, participating_cap_x: null,
    anti_dilution: "full_ratchet", protective_provisions_count: 8,
    redemption_rights: 1, board_investor_seats: 2, board_founder_seats: 2,
  });
  // LP 0.5 * 0.25 + part 1.0 * 0.20 + AD 1.0 * 0.25 + PP 0.3 * 0.10 + redemp 1*0.10 + board 1*0.10
  // = 0.125 + 0.20 + 0.25 + 0.03 + 0.10 + 0.10 = 0.805
  assert.ok(r.score >= 0.7, `expected >=0.7, got ${r.score}`);
  assert.equal(r.breakdown.find((b) => b.term === "anti_dilution").value, 1);
  assert.equal(r.breakdown.find((b) => b.term === "participating").value, 1);
});

test("scoreSeries: founder-friendly terms score near zero", () => {
  const r = scoreSeries({
    id: "x", series_name: "Series A", company_entity_id: "c",
    liquidation_pref_x: 1, participating: 0, participating_cap_x: null,
    anti_dilution: "broad_weighted", protective_provisions_count: 3,
    redemption_rights: 0, board_investor_seats: 1, board_founder_seats: 3,
  });
  assert.ok(r.score < 0.1, `expected <0.1, got ${r.score}`);
});

test("leak harvester: clamps confidence to ≤0.5", () => {
  const r = extractLeakCandidates({
    companyName: "Acme",
    sourceUrl: "https://twitter.com/x/status/1",
    excerpt: "Series B Preferred Stock: 1.5x liquidation preference. Non-participating. Broad-based weighted-average anti-dilution.",
  });
  assert.ok(r.series.length >= 1);
  for (const s of r.series) assert.ok(s.confidence <= 0.5);
});
