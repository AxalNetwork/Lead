// Task #13: per-format extractor tests.

import { test } from "node:test";
import assert from "node:assert/strict";

const { extractSafe } = await import("../../../../test-dist/services/documents/extractors/safe.js");
const { extractTermSheet } = await import("../../../../test-dist/services/documents/extractors/termSheet.js");
const { extractSha } = await import("../../../../test-dist/services/documents/extractors/sha.js");
const { extractCommercial } = await import("../../../../test-dist/services/documents/extractors/commercial.js");
const { extractNda } = await import("../../../../test-dist/services/documents/extractors/nda.js");
const { extractPitchDeck } = await import("../../../../test-dist/services/documents/extractors/pitchDeck.js");
const { extractFinancialModel } = await import("../../../../test-dist/services/documents/extractors/financialModel.js");

test("safe: post-money variant + cap + discount + MFN", () => {
  const text = `
    POST-MONEY SAFE
    Company: Acme Inc
    Investor: Sequoia Capital
    Purchase Amount: $500,000
    Post-Money Valuation Cap: $20,000,000
    Discount Rate: 20%
    This SAFE includes most favored nation provisions.
  `;
  const r = extractSafe(text);
  assert.equal(r.variant, "post_money");
  assert.equal(r.valuation_cap_usd, 20_000_000);
  assert.equal(r.purchase_amount_usd, 500_000);
  assert.equal(r.discount_pct, 0.2);
  assert.equal(r.mfn, true);
});

test("safe: numeric multipliers (5M = 5_000_000)", () => {
  const text = `Pre-money SAFE. Valuation Cap: $5M. Purchase amount: $250k.`;
  const r = extractSafe(text);
  assert.equal(r.valuation_cap_usd, 5_000_000);
  assert.equal(r.purchase_amount_usd, 250_000);
});

test("term_sheet: NVCA shape", () => {
  const text = `
    Series A Preferred Term Sheet
    Pre-money: $30,000,000
    Post-money: $40,000,000
    Raise: $10,000,000
    Liquidation preference: 1x non-participating
    Anti-dilution: broad-based weighted average
    Board Composition: 2 investor / 2 founder / 1 independent
    Option pool: 10%
    Pro Rata Right granted to all major investors.
  `;
  const r = extractTermSheet(text);
  assert.equal(r.pre_money_usd, 30_000_000);
  assert.equal(r.post_money_usd, 40_000_000);
  assert.equal(r.raise_amount_usd, 10_000_000);
  assert.equal(r.security_type, "preferred_stock");
  assert.equal(r.liquidation_preference_x, 1);
  assert.equal(r.liquidation_participating, false);
  assert.equal(r.anti_dilution, "broad_based_weighted_average");
  assert.equal(r.board_investor_seats, 2);
  assert.equal(r.board_founder_seats, 2);
  assert.equal(r.board_independent_seats, 1);
  assert.equal(r.option_pool_target_pct, 0.1);
  assert.equal(r.pro_rata, true);
});

test("sha: drag-along threshold + ROFR + tag-along", () => {
  const text = `
    Shareholders Agreement
    The board of directors shall consist of 5 directors.
    A Drag-Along right may be exercised when holders of at least 75% of the shares approve.
    Tag-Along rights apply to all minority holders.
    Right of First Refusal (ROFR) is granted to existing shareholders.
    Preemptive rights also apply.
    Information rights are provided quarterly.
  `;
  const r = extractSha(text);
  assert.equal(r.drag_along_threshold_pct, 0.75);
  assert.equal(r.tag_along, true);
  assert.equal(r.rofr, true);
  assert.equal(r.preemptive_right, true);
  assert.equal(r.board_size, 5);
  assert.equal(r.information_rights, true);
});

test("commercial: ACV + term + auto-renew + notice + governing law", () => {
  const text = `
    Master Services Agreement between Acme Corp and CustomerCo Inc.
    Annual Contract Value: $120,000
    Total Contract Value: $360,000
    Initial term: 36 months. This agreement will automatically renew unless
    written notice of non-renewal is provided 60 days prior to expiration.
    Payment terms: Net 30.
    This Agreement is governed by the laws of the State of Delaware.
  `;
  const r = extractCommercial(text);
  assert.equal(r.acv_usd, 120_000);
  assert.equal(r.tcv_usd, 360_000);
  assert.equal(r.term_months, 36);
  assert.equal(r.auto_renew, true);
  assert.equal(r.notice_period_days, 60);
  assert.equal(r.payment_terms_days, 30);
  assert.equal(r.governing_law, "Delaware");
  assert.ok(r.parties.length >= 2);
});

test("nda: mutual + unusual non-compete flag + ip assignment", () => {
  const text = `
    Mutual Non-Disclosure Agreement.
    Each party shall protect Confidential Information.
    Term of this Agreement: 3 years.
    The Receiving Party shall not non-compete during the term.
    Includes assignment of all intellectual property to Disclosing Party.
    Governed by the laws of California.
  `;
  const r = extractNda(text);
  assert.equal(r.is_mutual, true);
  assert.equal(r.term_months, 36);
  assert.equal(r.governing_law, "California");
  assert.ok(r.unusual_clause_flags.includes("non_compete"));
  assert.ok(r.unusual_clause_flags.includes("ip_assignment"));
});

test("pitch_deck: problem/solution/TAM/ask", () => {
  const text = `Acme AI
Reimagining sales enablement
Problem:
Sales teams burn 40% of their time on busywork instead of selling.

Solution:
Acme AI auto-generates meeting prep and follow-ups.

Market:
TAM $50B in 2030.

The Ask:
Raising $5M Series A.
`;
  const r = extractPitchDeck(text);
  assert.ok(r.problem && r.problem.toLowerCase().includes("sales teams"));
  assert.ok(r.solution && r.solution.toLowerCase().includes("acme ai"));
  assert.equal(r.tam_usd, 50_000_000_000);
  assert.equal(r.ask_amount_usd, 5_000_000);
});

test("financial_model: extracts ARR + revenue + burn + headcount series", () => {
  const sheets = [{
    name: "P&L",
    headers: ["Metric", "2024 Q1", "2024 Q2", "2024 Q3", "2024 Q4"],
    rows: [
      { Metric: "Revenue", "2024 Q1": 1_000_000, "2024 Q2": 1_500_000, "2024 Q3": 2_000_000, "2024 Q4": 3_000_000 },
      { Metric: "ARR", "2024 Q1": 4_000_000, "2024 Q2": 6_000_000, "2024 Q3": 8_000_000, "2024 Q4": 12_000_000 },
      { Metric: "Net Burn", "2024 Q1": -500_000, "2024 Q2": -600_000, "2024 Q3": -700_000, "2024 Q4": -800_000 },
      { Metric: "Headcount", "2024 Q1": 20, "2024 Q2": 25, "2024 Q3": 30, "2024 Q4": 40 },
    ],
  }];
  const r = extractFinancialModel(sheets);
  assert.equal(r.arr_ramp_usd.length, 4);
  assert.equal(r.revenue_by_period_usd.length, 4);
  assert.equal(r.burn_by_period_usd.length, 4);
  assert.equal(r.headcount_by_period.length, 4);
  assert.equal(r.arr_ramp_usd[3].arr_usd, 12_000_000);
  assert.equal(r.burn_by_period_usd[0].burn_usd, 500_000); // absolute value
  assert.equal(r.warnings.length, 0);
});

test("financial_model: no series found => warning", () => {
  const r = extractFinancialModel([{ name: "Cover", headers: ["A"], rows: [{ A: "Title" }] }]);
  assert.ok(r.warnings.includes("no_revenue_or_arr_series_found"));
});
