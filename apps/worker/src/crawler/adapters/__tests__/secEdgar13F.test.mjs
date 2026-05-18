// Task #1: Form 13F-HR parser test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dirname, "fixtures", n), "utf8");

const { parseEdgarPage, parseForm13F } = await import("../../../../test-dist/crawler/adapters/secEdgar.js");

test("Form 13F: extracts holdings with cusip, value, shares from XML", () => {
  const url = "https://www.sec.gov/Archives/edgar/data/1234567/000123456724000200/infotable.xml";
  const xml = fixture("sec-form-13f.xml");
  const parsed = parseEdgarPage(xml, url);
  // 13F XML is picked up via the body form-detect; result.kind may be
  // "13f" or "index" depending on form sniff. Force-call the parser
  // directly to assert the holdings-extraction contract.
  const header = parsed.header;
  const data = parseForm13F(xml, url, header);
  assert.equal(data.holdings.length, 3, `expected 3 holdings, got ${data.holdings.length}`);
  const apple = data.holdings.find((h) => h.cusip === "037833100");
  assert.ok(apple, "expected AAPL holding");
  // 13F XML reports value in $1000s — parser multiplies up to actual USD.
  assert.equal(apple.value_usd, 1500000 * 1000);
  assert.equal(apple.shares_or_principal, 7800000);
  assert.equal(apple.share_type, "SH");
  assert.equal(apple.investment_discretion, "SOLE");
  assert.equal(apple.voting_sole, 7800000);
  // Total value across all holdings.
  const expectedTotal = (1500000 + 980000 + 620000) * 1000;
  assert.equal(data.total_value_usd, expectedTotal);
});
