// Task #9: N-PORT XML parser tests.

import { test } from "node:test";
import assert from "node:assert/strict";

const { extractNportHoldings, filterPrivateCompanyHoldings } = await import(
  "../../../../test-dist/services/valuation/nportParser.js"
);

const SAMPLE_XML = `<?xml version="1.0"?>
<edgarSubmission>
  <formData>
    <genInfo>
      <regName>T. Rowe Price Blue Chip Growth Fund</regName>
      <seriesName>Blue Chip Growth</seriesName>
      <repPdEnd>2024-09-30</repPdEnd>
    </genInfo>
    <invstOrSecs>
      <invstOrSec>
        <name>Stripe Inc</name>
        <cusip>000000000</cusip>
        <valUSD>123456789.00</valUSD>
        <pctVal>0.45</pctVal>
        <assetCat>EC</assetCat>
        <isRestrictedSec>Y</isRestrictedSec>
        <fairValLevel>3</fairValLevel>
      </invstOrSec>
      <invstOrSec>
        <name>Apple Inc</name>
        <cusip>037833100</cusip>
        <valUSD>500000000.00</valUSD>
        <pctVal>1.82</pctVal>
        <assetCat>EC</assetCat>
        <isRestrictedSec>N</isRestrictedSec>
        <fairValLevel>1</fairValLevel>
      </invstOrSec>
      <invstOrSec>
        <name>SpaceX Class C</name>
        <valUSD>89000000.00</valUSD>
        <pctVal>0.32</pctVal>
        <assetCat>EP</assetCat>
        <isRestrictedSec>Y</isRestrictedSec>
        <fairValLevel>3</fairValLevel>
      </invstOrSec>
    </invstOrSecs>
  </formData>
</edgarSubmission>`;

test("extractNportHoldings pulls fund name + period + holdings", () => {
  const r = extractNportHoldings(SAMPLE_XML);
  assert.equal(r.ok, true);
  assert.equal(r.fund_name, "T. Rowe Price Blue Chip Growth Fund");
  assert.equal(r.period_of_report, "2024-09-30");
  assert.equal(r.holdings.length, 3);
  const stripe = r.holdings.find((h) => h.issuer_name === "Stripe Inc");
  assert.ok(stripe);
  assert.equal(stripe.value_usd, 123456789);
  assert.equal(stripe.is_restricted, true);
  assert.equal(stripe.fair_value_level, 3);
});

test("filterPrivateCompanyHoldings keeps restricted/L3 equity only", () => {
  const r = extractNportHoldings(SAMPLE_XML);
  const priv = filterPrivateCompanyHoldings(r.holdings);
  const names = priv.map((h) => h.issuer_name).sort();
  // Apple (public, not restricted, L1) is excluded; Stripe + SpaceX kept.
  assert.deepEqual(names, ["SpaceX Class C", "Stripe Inc"]);
});

test("extractNportHoldings returns ok=false on empty/short input", () => {
  const r = extractNportHoldings("<x/>");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_xml");
});

test("filterPrivateCompanyHoldings drops zero-value rows", () => {
  const priv = filterPrivateCompanyHoldings([
    { issuer_name: "X", cusip: null, value_usd: 0, pct_of_net_assets: 0, is_restricted: true, fair_value_level: 3, asset_category: "EC" },
    { issuer_name: "Y", cusip: null, value_usd: 100, pct_of_net_assets: 0.1, is_restricted: true, fair_value_level: 3, asset_category: "EC" },
  ]);
  assert.equal(priv.length, 1);
  assert.equal(priv[0].issuer_name, "Y");
});
