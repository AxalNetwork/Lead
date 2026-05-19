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

// --- Task #2: exit-signal enrichment helpers --------------------------------
const { sectorMedianMultiple, parseEscrowPct, parseIpoExtras } =
  await import("../../../../test-dist/services/fundReturns/exitSignal.js");

test("sectorMedianMultiple: returns known sector multiple", () => {
  assert.equal(sectorMedianMultiple(["saas"]), 8);
  assert.equal(sectorMedianMultiple(["SaaS"]), 8);
  assert.equal(sectorMedianMultiple(["ai", "consumer"]), 9);
});
test("sectorMedianMultiple: falls back to default for unknown / empty", () => {
  assert.equal(sectorMedianMultiple([]), 4);
  assert.equal(sectorMedianMultiple(null), 4);
  assert.equal(sectorMedianMultiple(["unobtanium"]), 4);
});

test("parseEscrowPct: extracts canonical 10% escrow", () => {
  assert.equal(parseEscrowPct("Closing includes 10% escrow over 18 months."), 0.10);
});
test("parseEscrowPct: extracts decimal holdback", () => {
  assert.equal(parseEscrowPct("Indemnity holdback of 12.5% retained."), 0.125);
});
test("parseEscrowPct: returns null when no escrow language", () => {
  assert.equal(parseEscrowPct("All cash deal closing Q3."), null);
  assert.equal(parseEscrowPct(null), null);
  assert.equal(parseEscrowPct(""), null);
});
test("parseEscrowPct: clamps absurd values to null", () => {
  // 99% escrow is obviously not what we mean — bail.
  assert.equal(parseEscrowPct("99% escrow"), null);
});

test("parseIpoExtras: pulls offer price and shares from prose", () => {
  const x = parseIpoExtras(
    "Priced at $24.00 per share. 10,000,000 shares offered.",
    "$240M",
    2_400_000_000,
  );
  assert.equal(x.ipo_offer_price_usd, 24);
  assert.equal(x.ipo_shares_sold, 10_000_000);
  // total shares = 2.4B / 24 = 100M; retained = 100M − 10M = 90M
  assert.equal(x.ipo_retained_shares, 90_000_000);
});
test("parseIpoExtras: returns nulls when nothing parsed", () => {
  const x = parseIpoExtras(null, null, null);
  assert.equal(x.ipo_offer_price_usd, null);
  assert.equal(x.ipo_shares_sold, null);
  assert.equal(x.ipo_retained_shares, null);
});

// --- Task #2: bias-correction application path ------------------------------
const { applyBiasCorrection } = await import("../../../../test-dist/services/fundReturns/calibration.js");

test("applyBiasCorrection: bias=1.0 is identity", () => {
  const r = applyBiasCorrection({
    distributed_usd: 50_000_000, residual_usd: 70_000_000,
    called_usd: 100_000_000, invested_usd: 100_000_000, bias: 1.0,
  });
  assert.equal(r.distributed_adj_usd, 50_000_000);
  assert.equal(r.residual_adj_usd, 70_000_000);
  assert.equal(r.dpi, 0.5);
  assert.equal(r.tvpi, 1.2);
  assert.equal(r.moic, 1.2);
});
test("applyBiasCorrection: 0.8 deflates modeled TVPI by 20%", () => {
  // We modeled rich; calibration says actuals are systematically lower.
  const r = applyBiasCorrection({
    distributed_usd: 100_000_000, residual_usd: 100_000_000,
    called_usd: 100_000_000, invested_usd: 100_000_000, bias: 0.8,
  });
  assert.equal(Number(r.tvpi.toFixed(4)), 1.6);   // (80M+80M)/100M
  assert.equal(Number(r.dpi.toFixed(4)), 0.8);
  assert.equal(Number(r.moic.toFixed(4)), 1.6);
});
test("applyBiasCorrection: 1.3 inflates modeled TVPI by 30%", () => {
  const r = applyBiasCorrection({
    distributed_usd: 100_000_000, residual_usd: 100_000_000,
    called_usd: 100_000_000, invested_usd: 100_000_000, bias: 1.3,
  });
  assert.equal(Number(r.tvpi.toFixed(4)), 2.6);
});
test("applyBiasCorrection: returns null metrics when called/invested are zero", () => {
  const r = applyBiasCorrection({
    distributed_usd: 0, residual_usd: 0, called_usd: 0, invested_usd: 0, bias: 1.1,
  });
  assert.equal(r.dpi, null);
  assert.equal(r.tvpi, null);
  assert.equal(r.moic, null);
});

// --- Task #2: lookupBiasCorrection DB path with mock D1 ---------------------
const { lookupBiasCorrection } = await import("../../../../test-dist/services/fundReturns/calibration.js");

function mockEnv(rows /* [{ vintage_year, strategy_key, bias_correction, sample_size }] */) {
  return {
    DB: {
      prepare(sql) {
        const wantsExact = /strategy_key\s*=\s*\?/.test(sql);
        let _params = [];
        const built = {
          bind(...p) { _params = p; return built; },
          async first() {
            const [v, sk] = _params;
            const match = rows.find(r =>
              r.vintage_year === v &&
              r.sample_size >= 3 &&
              (wantsExact ? r.strategy_key === sk : r.strategy_key === "")
            );
            return match ? { bias_correction: match.bias_correction } : null;
          },
          async all() { return { results: [] }; },
        };
        return built;
      },
    },
  };
}

test("lookupBiasCorrection: returns 1.0 when vintage_year null", async () => {
  const env = mockEnv([]);
  assert.equal(await lookupBiasCorrection(env, null, "venture"), 1.0);
});
test("lookupBiasCorrection: prefers strategy-specific bucket", async () => {
  const env = mockEnv([
    { vintage_year: 2019, strategy_key: "venture", bias_correction: 0.85, sample_size: 5 },
    { vintage_year: 2019, strategy_key: "",        bias_correction: 1.20, sample_size: 8 },
  ]);
  assert.equal(await lookupBiasCorrection(env, 2019, "venture"), 0.85);
});
test("lookupBiasCorrection: falls back to strategy-agnostic ('' sentinel)", async () => {
  const env = mockEnv([
    { vintage_year: 2018, strategy_key: "", bias_correction: 1.10, sample_size: 6 },
  ]);
  assert.equal(await lookupBiasCorrection(env, 2018, "venture"), 1.10);
});
test("lookupBiasCorrection: ignores buckets with sample_size < 3", async () => {
  const env = mockEnv([
    { vintage_year: 2020, strategy_key: "venture", bias_correction: 0.5, sample_size: 2 },
  ]);
  assert.equal(await lookupBiasCorrection(env, 2020, "venture"), 1.0);
});
test("lookupBiasCorrection: returns 1.0 when no bucket matches", async () => {
  const env = mockEnv([]);
  assert.equal(await lookupBiasCorrection(env, 2017, "growth"), 1.0);
});

// --- Task #2: undisclosed M&A integration: parseEscrowPct + sectorMedianMultiple
// + estimateProceeds together activate the sector-multiple fallback when
// deal_size is null but inferred revenue is present.
test("undisclosed M&A: sector multiple × inferred revenue × ownership × (1-escrow) realizes proceeds", () => {
  const escrow = parseEscrowPct("10% escrow over 12 months.");
  const mult = sectorMedianMultiple(["saas"]);
  const est = estimateProceeds({
    company_entity_id: "c-undisclosed",
    company_name: "QuietCo",
    position_usd: 5_000_000,
    ownership_pct: 0.08,
    exit: {
      event_kind: "acquisition",
      event_date: "2024-06-01",
      ma_deal_size_usd: null,                          // undisclosed
      ma_escrow_pct: escrow,
      ma_sector_median_multiple: mult,                 // 8x for saas
      ma_inferred_revenue_usd: 50_000_000,             // ARR fact on company
      source_url: "https://example.com/m-and-a",
    },
  });
  // deal_size = 50M × 8 = 400M; net = 400M × (1 − 0.10) = 360M; ownership 8% → 28.8M.
  assert.ok(est.realized_usd > 28_000_000 && est.realized_usd < 29_500_000,
    `realized was ${est.realized_usd}`);
  assert.equal(est.event_kind, "acquisition");
});
// --- Task #2: dealRow → ExitSignal mapper (pure end-to-end of the
//     production-path transform, minus the DB roundtrip the model.ts
//     wrapper performs). Re-runs through estimateProceeds to prove
//     fallback proceeds materialize from a real-shaped deal row + a
//     pre-fetched revenue fact. ---------------------------------------
const { dealRowToExitSignal } = await import("../../../../test-dist/services/fundReturns/exitSignal.js");

test("dealRowToExitSignal: M&A with undisclosed deal_size + ARR fact realizes proceeds via sector multiple", () => {
  const sig = dealRowToExitSignal({
    event_type: "acquisition",
    amount_usd: null,                                  // undisclosed
    valuation_usd: null,
    announcement_date: "2024-06-01",
    source_url: "https://example.com/ma",
    amount_raw: null,
    use_of_proceeds: "Indemnity holdback of 10% retained.",
    sector_tags_json: '["saas"]',
  }, 50_000_000 /* pre-fetched ARR fact */);
  assert.equal(sig.event_kind, "acquisition");
  assert.equal(sig.ma_deal_size_usd, null);
  assert.equal(sig.ma_escrow_pct, 0.10);
  assert.equal(sig.ma_sector_median_multiple, 8);        // saas
  assert.equal(sig.ma_inferred_revenue_usd, 50_000_000);

  // 50M × 8 = 400M proxy; × (1 − 0.10) = 360M; × 5% ownership = 18M.
  const est = estimateProceeds({
    company_entity_id: "co-undisclosed", company_name: "QuietCo",
    position_usd: 5_000_000, ownership_pct: 0.05, exit: sig,
  });
  assert.ok(est.realized_usd > 17_900_000 && est.realized_usd < 18_100_000,
    `realized was ${est.realized_usd}`);
  assert.ok(est.notes.includes("ma_used_sector_median_multiple"));
});

test("dealRowToExitSignal: M&A with no revenue fact keeps fallback inert and surfaces the note", () => {
  const sig = dealRowToExitSignal({
    event_type: "acquisition",
    amount_usd: null, valuation_usd: null,
    announcement_date: "2024-06-01",
    source_url: null, amount_raw: null,
    use_of_proceeds: null, sector_tags_json: '["saas"]',
  }, null /* no revenue fact on company */);
  assert.equal(sig.ma_inferred_revenue_usd, null);
  const est = estimateProceeds({
    company_entity_id: "co-blank", company_name: "BlankCo",
    position_usd: 5_000_000, ownership_pct: 0.05, exit: sig,
  });
  assert.equal(est.realized_usd, 0);
  assert.ok(est.notes.includes("ma_undisclosed_deal_size"));
});

test("dealRowToExitSignal: IPO populates offer price, shares sold, and backed-out retained", () => {
  const sig = dealRowToExitSignal({
    event_type: "ipo",
    amount_usd: null,
    valuation_usd: 2_400_000_000,
    announcement_date: "2024-04-01",
    source_url: "https://sec.gov/x",
    amount_raw: "$240M",
    use_of_proceeds: "Priced at $24.00 per share. 10,000,000 shares offered.",
    sector_tags_json: null,
  }, null);
  assert.equal(sig.event_kind, "ipo");
  assert.equal(sig.ipo_offer_price_usd, 24);
  assert.equal(sig.ipo_shares_sold, 10_000_000);
  assert.equal(sig.ipo_retained_shares, 90_000_000);
});

test("dealRowToExitSignal: bankruptcy short-circuits to zero-realized signal", () => {
  const sig = dealRowToExitSignal({
    event_type: "bankruptcy",
    amount_usd: null, valuation_usd: null,
    announcement_date: "2024-02-01",
    source_url: "https://example.com/ch11",
    amount_raw: null, use_of_proceeds: null, sector_tags_json: null,
  }, null);
  assert.equal(sig.event_kind, "bankruptcy");
});

test("dealRowToExitSignal: unrecognized event_type returns null", () => {
  const sig = dealRowToExitSignal({
    event_type: "funding_round",
    amount_usd: 10_000_000, valuation_usd: 100_000_000,
    announcement_date: "2024-05-01",
    source_url: null, amount_raw: null, use_of_proceeds: null, sector_tags_json: null,
  }, null);
  assert.equal(sig, null);
});

test("undisclosed M&A: missing inferred revenue means fallback does NOT silently activate", () => {
  const est = estimateProceeds({
    company_entity_id: "c-blank",
    company_name: "BlankCo",
    position_usd: 5_000_000,
    ownership_pct: 0.08,
    exit: {
      event_kind: "acquisition",
      event_date: "2024-06-01",
      ma_deal_size_usd: null,
      ma_escrow_pct: 0,
      ma_sector_median_multiple: 8,
      ma_inferred_revenue_usd: null,                   // unknown
      source_url: null,
    },
  });
  // Estimator should NOT manufacture proceeds out of thin air.
  assert.equal(est.realized_usd, 0);
});
