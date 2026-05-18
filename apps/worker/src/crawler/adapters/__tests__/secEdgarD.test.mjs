// Task #1: Form D parser test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dirname, "fixtures", n), "utf8");

const { parseEdgarPage } = await import("../../../../test-dist/crawler/adapters/secEdgar.js");

test("Form D: extracts issuer, offering amount, exemption, related persons", () => {
  const url = "https://www.sec.gov/Archives/edgar/data/9876543/000123456724000099/0001234567-24-000099-index.htm";
  const html = fixture("sec-form-d.html");
  const parsed = parseEdgarPage(html, url);
  assert.equal(parsed.kind, "form_d");
  if (parsed.kind !== "form_d") throw new Error("kind mismatch");
  assert.match(parsed.data.issuer_name, /ACME ROBOTICS/i);
  assert.equal(parsed.data.issuer_jurisdiction, "DELAWARE");
  assert.equal(parsed.data.issuer_year_of_inc, 2021);
  assert.equal(parsed.data.total_offering_amount, 25000000);
  assert.equal(parsed.data.total_amount_sold, 25000000);
  assert.equal(parsed.data.total_investors, 14);
  assert.equal(parsed.data.minimum_investment, 250000);
  assert.equal(parsed.data.date_of_first_sale, "2024-03-15");
  assert.equal(parsed.data.exemption_claimed, "506(b)");
  assert.ok(parsed.data.related_persons.length >= 2, "expected 2 related persons");
  assert.match(parsed.data.related_persons[0].name, /SMITH/i);
  assert.equal(parsed.header.accession_no, "0001234567-24-000099");
});
