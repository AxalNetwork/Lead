// Sync-only unit tests for the profile parser registry. Async dispatchers
// (LinkedIn search, Nitter fetch, GitHub REST, multi-page personal probe)
// require env + network and are exercised in integration. Here we cover
// the pure HTML→data extractors:
//
//   * crunchbase-person  — __NEXT_DATA__ → ParsedLead
//   * crunchbase-org     — __NEXT_DATA__ → FirmCandidate
//   * personal (sync)    — JSON-LD person + mailto + socials
//
// Run via `npm test` from apps/worker (which compiles to test-dist first).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(__dirname, "profile-fixtures", name), "utf8");

const { parseCrunchbasePerson } = await import("../test-dist/scraper/parsers/profile/crunchbase-person.js");
const { parseCrunchbaseOrg } = await import("../test-dist/scraper/parsers/profile/crunchbase-org.js");
const { parse: parseProfile, detectProfileKind } = await import("../test-dist/scraper/parsers/profile.js");
const { isLinkedInProfileUrl } = await import("../test-dist/scraper/parsers/profile/linkedin.js");
const { isTwitterProfileUrl, handleFromTwitterUrl } = await import("../test-dist/scraper/parsers/profile/nitter.js");
const { isGithubProfileUrl } = await import("../test-dist/scraper/parsers/profile/github.js");
const { isNfxProfileUrl } = await import("../test-dist/scraper/parsers/profile/nfx.js");

test("detectProfileKind routes by URL host", () => {
  assert.equal(detectProfileKind("https://www.linkedin.com/in/janedoe"), "linkedin");
  assert.equal(detectProfileKind("https://twitter.com/janedoe"), "twitter");
  assert.equal(detectProfileKind("https://x.com/janedoe"), "twitter");
  assert.equal(detectProfileKind("https://github.com/janedoe"), "github");
  assert.equal(detectProfileKind("https://signal.nfx.com/x"), "nfx");
  assert.equal(detectProfileKind("https://www.crunchbase.com/person/jane-doe"), "crunchbase_person");
  assert.equal(detectProfileKind("https://www.crunchbase.com/organization/acme"), "crunchbase_org");
  assert.equal(detectProfileKind("https://janedoe.example/"), "personal");
});

test("URL detectors reject negatives", () => {
  assert.equal(isLinkedInProfileUrl("https://linkedin.com/company/acme"), false);
  assert.equal(isLinkedInProfileUrl("https://www.linkedin.com/in/janedoe"), true);
  assert.equal(isTwitterProfileUrl("https://twitter.com/i/notifications"), false);
  assert.equal(isTwitterProfileUrl("https://x.com/janedoe"), true);
  assert.equal(handleFromTwitterUrl("https://x.com/janedoe"), "janedoe");
  assert.equal(isGithubProfileUrl("https://github.com/orgs/foo"), false);
  assert.equal(isGithubProfileUrl("https://github.com/janedoe"), true);
  assert.equal(isNfxProfileUrl("https://signal.nfx.com/list/123"), true);
  assert.equal(isNfxProfileUrl("https://nfx.com/post/whatever"), false);
});

test("parseCrunchbasePerson extracts NEXT_DATA fields", () => {
  const html = fx("crunchbase-person.html");
  const url = "https://www.crunchbase.com/person/jane-doe";
  const leads = parseCrunchbasePerson(html, url);
  assert.equal(leads.length, 1);
  const l = leads[0];
  assert.equal(l.name, "Jane Doe");
  assert.equal(l.title, "Partner");
  assert.equal(l.org, "Acme Capital");
  assert.equal(l.category, "crunchbase_profile");
  assert.equal(l.meta.parser, "profile/crunchbase-person");
  assert.equal(l.meta.location, "San Francisco, California, United States");
  const socialPlatforms = l.meta.socials.map((s) => s.platform).sort();
  assert.ok(socialPlatforms.includes("twitter"));
  assert.ok(socialPlatforms.includes("linkedin"));
});

test("parseCrunchbaseOrg returns a FirmCandidate matching firms schema", () => {
  const html = fx("crunchbase-org.html");
  const url = "https://www.crunchbase.com/organization/acme-capital";
  const firm = parseCrunchbaseOrg(html, url);
  assert.ok(firm, "firm candidate should be returned");
  assert.equal(firm.name, "Acme Capital");
  assert.equal(firm.legal_name, "Acme Capital LLC");
  assert.equal(firm.website, "https://acme.example");
  assert.equal(firm.domain, "acme.example");
  assert.equal(firm.founded_year, 2018);
  assert.equal(firm.hq_city, "San Francisco");
  assert.equal(firm.hq_region, "California");
  assert.equal(firm.hq_country_iso2, null);
  assert.ok(firm.notes && firm.notes.includes("United States"));
  assert.deepEqual(firm.sectors, ["Artificial Intelligence", "Software"]);
  assert.equal(firm.crunchbase_url, url);
});

test("parseProfile (sync) routes to personal extractor", () => {
  const html = fx("personal.html");
  const url = "https://janedoe.example/";
  const leads = parseProfile(html, url);
  assert.ok(leads.length >= 1);
  const named = leads.find((l) => l.name === "Jane Doe");
  assert.ok(named, "should find a Jane Doe lead");
  assert.equal(named.email, "jane@example.com");
  assert.equal(named.title, "Partner");
});

test("parseProfile (sync) routes Crunchbase URLs to JSON parser", () => {
  const html = fx("crunchbase-person.html");
  const leads = parseProfile(html, "https://www.crunchbase.com/person/jane-doe");
  assert.equal(leads[0].meta.parser, "profile/crunchbase-person");
});
