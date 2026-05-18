// Task #2 acceptance tests for site adapters. Loads fixture HTML and
// asserts each adapter emits the expected candidates / child URLs.
// Compiled by `tsc -p tsconfig.test.json` first; we import from
// `../test-dist/` like the rest of the worker suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "crawler-adapter-fixtures");
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

const adaptersMod = await import("../test-dist/crawler/adapters/index.js");
const { pickAdapter, runAdapter, ADAPTERS } = adaptersMod;
const { archiveKey } = await import("../test-dist/crawler/archive.js");

test("pickAdapter routes well-known hosts to the right adapter", () => {
  assert.equal(pickAdapter("https://www.linkedin.com/in/janedoe")?.id, "linkedin_public");
  assert.equal(pickAdapter("https://www.crunchbase.com/organization/acme-capital")?.id, "crunchbase_public");
  assert.equal(pickAdapter("https://www.sec.gov/cgi-bin/browse-edgar?CIK=12345")?.id, "sec_edgar");
  assert.equal(pickAdapter("https://www.firstround.com/team/")?.id, "venture_partner_listings");
  assert.equal(pickAdapter("https://en.wikipedia.org/wiki/Marc_Andreessen")?.id, "wikipedia");
  assert.equal(pickAdapter("https://arxiv.org/abs/2401.12345")?.id, "arxiv");
  assert.equal(pickAdapter("https://github.com/octocat")?.id, "github_public");
  assert.equal(pickAdapter("https://www.congress.gov/member/jane-doe/D12345")?.id, "congress_gov");
});

test("pickAdapter returns null for hosts no adapter claims", () => {
  assert.equal(pickAdapter("https://example.com/random/page"), null);
  assert.equal(pickAdapter("not-a-url"), null);
});

test("linkedin_public extracts a person candidate from /in/<handle>", () => {
  const r = runAdapter("https://www.linkedin.com/in/janedoe", fixture("linkedin-in.html"));
  assert.equal(r.used_adapter_id, "linkedin_public");
  assert.equal(r.fallback_reason, null);
  const cand = r.result.candidates.find((c) => c.profile_type === "firm_person");
  assert.ok(cand, "expected a firm_person candidate");
  assert.equal(cand.name, "Jane Doe");
  assert.equal(cand.data.firm_employer, "Acme Capital");
  assert.equal(cand.data.linkedin_slug, "janedoe");
});

test("crunchbase_public parses __NEXT_DATA__ org node", () => {
  const url = "https://www.crunchbase.com/organization/acme-capital";
  const r = runAdapter(url, fixture("crunchbase-org.html"));
  assert.equal(r.used_adapter_id, "crunchbase_public");
  assert.equal(r.fallback_reason, null);
  const cand = r.result.candidates[0];
  const data = cand.data;
  assert.equal(cand.name, "Acme Capital");
  assert.equal(data.legal_name, "Acme Capital LLC");
  assert.equal(data.website, "https://acme.vc");
  assert.equal(data.founded_year, 2015);
  assert.equal(data.hq_city, "San Francisco");
  assert.deepEqual(data.sectors, ["Venture Capital", "Financial Services"]);
});

test("sec_edgar parses filing rows and emits child URLs", () => {
  const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000012345&type=10-K";
  const r = runAdapter(url, fixture("sec-edgar.html"));
  assert.equal(r.used_adapter_id, "sec_edgar");
  const data = r.result.candidates[0].data;
  assert.equal(data.cik, "0000012345");
  assert.equal(data.registrant_name, "EXAMPLE TECHNOLOGIES INC.");
  assert.ok(data.filings.length >= 3, `expected >=3 filings, got ${data.filings.length}`);
  assert.ok(data.filings.some((f) => f.form === "10-K"));
  assert.ok(r.result.child_urls.length > 0, "expected child filing URLs");
});

test("venture_partner_listings yields multiple gp_partner candidates on /team/", () => {
  const url = "https://www.firstround.com/team/";
  const r = runAdapter(url, fixture("firstround-team.html"));
  assert.equal(r.used_adapter_id, "venture_partner_listings");
  assert.equal(r.fallback_reason, null);
  const partners = r.result.candidates.filter((c) => c.profile_type === "gp_partner");
  assert.ok(partners.length >= 5, `expected >=5 gp_partners, got ${partners.length}`);
  for (const p of partners) {
    assert.ok(p.url && /firstround\.com\/team\/[a-z]/.test(p.url), `unexpected url ${p.url}`);
    assert.equal(p.data.firm_employer, "firstround");
  }
  const names = partners.map((p) => p.name);
  assert.ok(!names.includes("About") && !names.includes("Portfolio") && !names.includes("Careers"));
  assert.equal(r.result.child_urls.length, partners.length);
});

test("github_public extracts user metadata", () => {
  const r = runAdapter("https://github.com/octocat", fixture("github-user.html"));
  assert.equal(r.used_adapter_id, "github_public");
  const data = r.result.candidates[0].data;
  assert.equal(data.github_login, "octocat");
  assert.equal(data.is_org, false);
});

test("wikipedia detects person via infobox", () => {
  const r = runAdapter("https://en.wikipedia.org/wiki/Marc_Andreessen", fixture("wikipedia.html"));
  assert.equal(r.used_adapter_id, "wikipedia");
  const cand = r.result.candidates[0];
  assert.equal(cand.name, "Marc Andreessen");
  assert.equal(cand.data.is_person, true);
  assert.equal(cand.data.infobox.born, "July 9, 1971");
});

test("arxiv pulls citation metadata", () => {
  const r = runAdapter("https://arxiv.org/abs/2401.12345", fixture("arxiv.html"));
  assert.equal(r.used_adapter_id, "arxiv");
  const data = r.result.candidates[0].data;
  assert.equal(data.arxiv_id, "2401.12345");
  assert.equal(data.title, "An Example Paper on Transformers");
  assert.deepEqual(data.authors, ["Smith, Alice", "Doe, Jane"]);
});

test("congress_gov extracts member metadata", () => {
  const r = runAdapter("https://www.congress.gov/member/jane-doe/D12345", fixture("congress-member.html"));
  assert.equal(r.used_adapter_id, "congress_gov");
  const cand = r.result.candidates[0];
  assert.equal(cand.profile_type, "politician_federal");
  assert.equal(cand.data.party, "Democratic");
  assert.equal(cand.data.state, "California");
  assert.equal(cand.data.chamber, "House");
});

test("runAdapter recovers from adapter exceptions without throwing", () => {
  const target = ADAPTERS.find((a) => a.id === "wikipedia");
  const original = target.extract.bind(target);
  target.extract = () => { throw new Error("boom"); };
  try {
    const r = runAdapter("https://en.wikipedia.org/wiki/Anything", "<html/>");
    assert.equal(r.fallback_reason, "adapter_threw");
    assert.equal(r.adapter_error, "boom");
    assert.equal(r.result, null);
  } finally {
    target.extract = original;
  }
});

test("archiveKey is day-prefixed and 16-hex sliced for lifecycle policy", () => {
  const k = archiveKey("https://example.com/x", "2025-05-18T12:00:00Z", "a".repeat(64));
  assert.equal(k, "crawler/2025-05-18/aaaaaaaaaaaaaaaa.html");
});
