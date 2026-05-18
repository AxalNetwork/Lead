// Task #1: Form ADV parser test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dirname, "fixtures", n), "utf8");

const { runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");
const { parseEdgarPage } = await import("../../../../test-dist/crawler/adapters/secEdgar.js");

test("Form ADV: extracts adviser, CRD, AUM, funds, control persons", () => {
  const url = "https://adviserinfo.sec.gov/firm/summary/134467?CIK=0001234567";
  const html = fixture("sec-form-adv.html");
  const parsed = parseEdgarPage(html, url);
  assert.equal(parsed.kind, "adv");
  if (parsed.kind !== "adv") throw new Error("kind mismatch");
  assert.equal(parsed.data.adviser_crd, "134467");
  assert.equal(parsed.data.adviser_sec_no, "801-67890");
  assert.match(parsed.data.adviser_name, /FIRST ROUND CAPITAL/i);
  assert.equal(parsed.data.total_aum_usd, 3400000000);
  assert.equal(parsed.data.employee_count, 42);
  assert.ok(parsed.data.website?.includes("firstround.com"));
  assert.ok(parsed.data.funds.length >= 3, `expected >=3 funds, got ${parsed.data.funds.length}`);
  const f1 = parsed.data.funds.find((f) => f.fund_id_807 === "807-12345678");
  assert.ok(f1, "expected fund 807-12345678");
  assert.equal(f1.fund_type, "venture_capital_fund");
  assert.equal(f1.gross_asset_value, 850000000);
  assert.ok(parsed.data.control_persons.length >= 1, "expected control persons");
  const kop = parsed.data.control_persons.find((p) => /KOPELMAN/i.test(p.name));
  assert.ok(kop, "expected Kopelman in control persons");
});

test("Form ADV: adapter surfaces investor_vc profile_type + cik", () => {
  const url = "https://adviserinfo.sec.gov/firm/summary/134467?CIK=0001234567";
  const r = runAdapter(url, fixture("sec-form-adv.html"));
  assert.equal(r.used_adapter_id, "sec_edgar");
  assert.equal(r.result.candidates[0].profile_type, "investor_vc");
  assert.equal(r.result.candidates[0].data.cik, "0001234567");
  assert.equal(r.result.candidates[0].data.parsed_kind, "adv");
});
