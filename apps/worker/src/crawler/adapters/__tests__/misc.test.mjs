// Misc adapter coverage + framework-level tests (pickAdapter, runAdapter
// fallback behavior, archive key shape).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const fixture = (name) => readFileSync(join(FIX, name), "utf8");

const adaptersMod = await import("../../../../test-dist/crawler/adapters/index.js");
const { pickAdapter, runAdapter, ADAPTERS } = adaptersMod;
const { archiveKey } = await import("../../../../test-dist/crawler/archive.js");

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

test("pickAdapter matches url_patterns against query string (e.g. Google Scholar)", () => {
  // googleScholarHtml claims `/citations?user=...` — the predicate is in the
  // query, not the path, so this exercises the path+query routing fix.
  const a = pickAdapter("https://scholar.google.com/citations?user=ABC123");
  assert.equal(a?.id, "google_scholar_html");
});

test("pickAdapter returns null for hosts no adapter claims", () => {
  assert.equal(pickAdapter("https://example.com/random/page"), null);
  assert.equal(pickAdapter("not-a-url"), null);
});

test("githubPublic: extracts user metadata", () => {
  const r = runAdapter("https://github.com/octocat", fixture("github-user.html"));
  assert.equal(r.used_adapter_id, "github_public");
  const data = r.result.candidates[0].data;
  assert.equal(data.github_login, "octocat");
  assert.equal(data.is_org, false);
});

test("wikipedia: detects person via infobox", () => {
  const r = runAdapter("https://en.wikipedia.org/wiki/Marc_Andreessen", fixture("wikipedia.html"));
  assert.equal(r.used_adapter_id, "wikipedia");
  const cand = r.result.candidates[0];
  assert.equal(cand.name, "Marc Andreessen");
  assert.equal(cand.data.is_person, true);
  assert.equal(cand.data.infobox.born, "July 9, 1971");
});

test("arxiv: pulls citation metadata", () => {
  const r = runAdapter("https://arxiv.org/abs/2401.12345", fixture("arxiv.html"));
  assert.equal(r.used_adapter_id, "arxiv");
  const data = r.result.candidates[0].data;
  assert.equal(data.arxiv_id, "2401.12345");
  assert.equal(data.title, "An Example Paper on Transformers");
  assert.deepEqual(data.authors, ["Smith, Alice", "Doe, Jane"]);
});

test("congressGov: extracts member metadata", () => {
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

test("runAdapter drops low-confidence result so generic extractor takes over", () => {
  const target = ADAPTERS.find((a) => a.id === "wikipedia");
  const original = target.extract.bind(target);
  target.extract = () => ({ adapter_id: "wikipedia", confidence: 0.05, candidates: [], child_urls: [] });
  try {
    const r = runAdapter("https://en.wikipedia.org/wiki/X", "<html/>");
    assert.equal(r.fallback_reason, "low_confidence");
    assert.equal(r.result, null, "low-confidence result must be dropped");
  } finally {
    target.extract = original;
  }
});

test("archiveKey is day-prefixed, 16-hex sliced, AND time-suffixed so same-day refetches don't overwrite", () => {
  const morning = archiveKey("https://example.com/x", "2025-05-18T01:02:03.456Z", "a".repeat(64));
  const evening = archiveKey("https://example.com/x", "2025-05-18T22:00:00.000Z", "a".repeat(64));
  assert.equal(morning, "crawler/2025-05-18/aaaaaaaaaaaaaaaa-010203456.html");
  assert.notEqual(morning, evening, "same URL on same day must yield distinct keys");
  // Lex order: morning sorts before evening, so a list() sort surfaces
  // the latest snapshot at the tail (relied on by readArchive).
  assert.ok(morning < evening);
});
