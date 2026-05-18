import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

const { runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("crunchbasePublic: parses org basics from __NEXT_DATA__", () => {
  const url = "https://www.crunchbase.com/organization/acme-capital";
  const r = runAdapter(url, fixture("crunchbase-org.html"));
  assert.equal(r.used_adapter_id, "crunchbase_public");
  assert.equal(r.fallback_reason, null);
  const org = r.result.candidates[0];
  assert.equal(org.name, "Acme Capital");
  assert.equal(org.data.legal_name, "Acme Capital LLC");
  assert.equal(org.data.website, "https://acme.vc");
  assert.equal(org.data.founded_year, 2015);
  assert.equal(org.data.hq_city, "San Francisco");
  assert.deepEqual(org.data.sectors, ["Venture Capital", "Financial Services"]);
  assert.equal(org.data.total_funding_usd, 250000000);
});

test("crunchbasePublic: extracts funding_rounds with round/date/amount/leads", () => {
  const url = "https://www.crunchbase.com/organization/acme-capital";
  const r = runAdapter(url, fixture("crunchbase-org.html"));
  const rounds = r.result.candidates[0].data.funding_rounds;
  assert.ok(Array.isArray(rounds) && rounds.length === 2, `expected 2 rounds, got ${rounds?.length}`);
  const a = rounds.find((x) => x.round === "Series A");
  assert.ok(a, "expected Series A round");
  assert.equal(a.date, "2018-04-12");
  assert.equal(a.amount_usd, 15000000);
  assert.deepEqual(a.lead_investors, ["Beta Ventures"]);
});

test("crunchbasePublic: surfaces team members as firm_person candidates + child URLs", () => {
  const url = "https://www.crunchbase.com/organization/acme-capital";
  const r = runAdapter(url, fixture("crunchbase-org.html"));
  const people = r.result.candidates.filter((c) => c.profile_type === "firm_person");
  assert.ok(people.length >= 2, `expected >=2 firm_person, got ${people.length}`);
  const alice = people.find((p) => p.name === "Alice Nguyen");
  assert.ok(alice, "expected Alice Nguyen");
  assert.equal(alice.data.role, "Founding Partner");
  assert.equal(alice.data.firm_employer, "Acme Capital");
  assert.ok(r.result.child_urls.some((u) => u.endsWith("/person/alice-nguyen")));
});
