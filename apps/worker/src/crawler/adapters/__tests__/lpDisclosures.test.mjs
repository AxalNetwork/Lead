// Task #2: LP-disclosure adapter + shared parser tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

const { runAdapter, pickAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");
const { calpers } = await import("../../../../test-dist/crawler/adapters/lpDisclosures/calpers.js");
const { parseLpTable, detectUnitMultiplier, findAsOfDate, parseMoney, parsePercent }
  = await import("../../../../test-dist/crawler/adapters/lpDisclosures/_shared.js");
const { normalizeFundName } = await import("../../../../test-dist/services/fundResolver.js");

test("shared: detectUnitMultiplier reads $ in thousands/millions/billions", () => {
  assert.equal(detectUnitMultiplier("$ in thousands"), 1_000);
  assert.equal(detectUnitMultiplier("Amounts in millions"), 1_000_000);
  assert.equal(detectUnitMultiplier("($ in billions)"), 1_000_000_000);
  assert.equal(detectUnitMultiplier("nothing here"), 1);
});

test("shared: findAsOfDate handles ISO / US / month-name / quarter", () => {
  assert.equal(findAsOfDate("as of 2024-06-30"), "2024-06-30");
  assert.equal(findAsOfDate("as of 06/30/2024"), "2024-06-30");
  assert.equal(findAsOfDate("as of June 30, 2024"), "2024-06-30");
  assert.equal(findAsOfDate("Q2 2024 report"), "2024-06-30");
  assert.equal(findAsOfDate("no date here"), null);
});

test("shared: parseMoney + parsePercent tolerate $, commas, parens, N/A, NM", () => {
  assert.equal(parseMoney("$1,234,567"), 1234567);
  assert.equal(parseMoney("(1,234)"), -1234);
  assert.equal(parseMoney("N/A"), null);
  assert.equal(parseMoney("—"), null);
  assert.equal(parsePercent("18.4%"), 18.4);
  assert.equal(parsePercent("(2.1)%"), -2.1);
  assert.equal(parsePercent("NM"), null);
});

test("calpers: adapter is registered + picks correct URL", () => {
  const adapter = pickAdapter("https://www.calpers.ca.gov/page/investments/asset-classes/private-equity/pe-program-fund-performance");
  assert.ok(adapter, "expected an adapter match for calpers URL");
  assert.equal(adapter.id, "lp_calpers");
});

test("calpers: extracts ~10 commitments with vintage / IRR / NAV", () => {
  const url = "https://www.calpers.ca.gov/page/investments/asset-classes/private-equity/pe-program-fund-performance";
  const text = fixture("lp-calpers.txt");
  const out = calpers.extract(text, url);
  assert.equal(out.adapter_id, "lp_calpers");
  assert.ok(out.confidence > 0.4, `confidence ${out.confidence}`);
  const payload = out.candidates[0].data;
  assert.equal(payload.lp_slug, "calpers");
  assert.equal(payload.lp_class, "pension");
  assert.equal(payload.as_of_date, "2024-06-30");
  // Header + total rows should NOT appear; expect 10 fund rows.
  assert.equal(payload.commitments.length, 10);
  const a16z = payload.commitments.find((c) => /andreessen.*lsv/i.test(c.fund_name_raw));
  assert.ok(a16z, "expected the a16z LSV row");
  assert.equal(a16z.vintage_year, 2021);
  // 150,000 * 1000 thousands-multiplier = 150_000_000
  assert.equal(a16z.committed_usd, 150_000_000);
  assert.equal(a16z.nav_usd, 170_500_000);
  assert.equal(a16z.net_irr_pct, 22.5);
  // Bain row should carry negative IRR via parens.
  const bain = payload.commitments.find((c) => /bain capital fund xiv/i.test(c.fund_name_raw));
  assert.ok(bain);
  assert.equal(bain.net_irr_pct, -4.2);
  // TPG row IRR is "N/A" → null.
  const tpg = payload.commitments.find((c) => /tpg partners ix/i.test(c.fund_name_raw));
  assert.equal(tpg.net_irr_pct, null);
});

test("runAdapter: routes calpers URL through registry", () => {
  const out = runAdapter(
    "https://www.calpers.ca.gov/page/investments/asset-classes/private-equity/pe-program-fund-performance",
    fixture("lp-calpers.txt"),
  );
  assert.equal(out.used_adapter_id, "lp_calpers");
  assert.equal(out.fallback_reason, null);
  assert.ok(out.result.candidates[0].data.commitments.length >= 10);
});

test("parseLpTable: drops subtotal + header rows", () => {
  const rows = parseLpTable(fixture("lp-calpers.txt"));
  for (const r of rows) {
    assert.ok(!/^total\b/i.test(r.fund_name_raw), `Total row leaked: ${r.fund_name_raw}`);
    assert.ok(!/^fund name\b/i.test(r.fund_name_raw), `Header row leaked: ${r.fund_name_raw}`);
  }
});

test("fundResolver: normalizeFundName collapses roman numerals + strips legal suffixes", () => {
  assert.equal(
    normalizeFundName("Andreessen Horowitz LSV Fund III, L.P."),
    normalizeFundName("andreessen horowitz lsv fund 3 lp"),
  );
  assert.equal(
    normalizeFundName("KKR North America Fund XIII, L.P."),
    normalizeFundName("KKR North America Fund 13 LP"),
  );
  // Different vintage numerals MUST normalize differently.
  assert.notEqual(
    normalizeFundName("Sequoia Capital Growth IX, L.P."),
    normalizeFundName("Sequoia Capital Growth VIII, L.P."),
  );
});
