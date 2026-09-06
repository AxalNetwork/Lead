// Read-path overlay for firms / companies / accounts.
//
// Everything automated writes into `facts`; these three detail pages read
// flat legacy columns and nothing else, so successfully-extracted thesis,
// contact_email, check sizes and AUM rendered as "—". These tests pin the
// two properties that make the overlay safe (legacy authority wins; unknown
// columns are never invented) and the one that makes it actually work (the
// `*_json` columns must receive a JSON string, because the dashboard parses
// them with JSON.parse — handing over a bare array silently renders "—").

import { test } from "node:test";
import assert from "node:assert/strict";

const { loadOrgEntityOverlay, applyOrgOverlay } = await import(
  "../test-dist/services/org_entity_merge.js"
);

// A D1 stand-in that answers by matching a fragment of the SQL.
function mockEnv(responses = {}) {
  const pick = (sql) => {
    for (const [frag, val] of Object.entries(responses)) {
      if (sql.includes(frag)) return val;
    }
    return null;
  };
  return {
    DB: {
      prepare(sql) {
        return {
          bind: () => ({
            first: async () => pick(sql),
            all: async () => ({ results: pick(sql) ?? [] }),
          }),
        };
      },
    },
  };
}

const MAP = { entity_legacy_map: { entity_id: "e-1" } };

// ---- applyOrgOverlay ---------------------------------------------------

const overlayWith = (o) => ({
  thesis: null, description: null, contact_email: null, founded_year: null,
  hq_city: null, hq_region: null, hq_country_iso2: null, aum_usd: null,
  check_size_min_usd: null, check_size_max_usd: null, check_size_typical_usd: null,
  website: null, domain: null, linkedin_url: null, twitter_handle: null,
  sectors: [], stages: [], geos: [],
  ...o,
});

test("fills a blank column from the overlay", () => {
  const out = applyOrgOverlay(
    { id: 1, thesis: null, contact_email: "" },
    overlayWith({ thesis: "We back seed infra.", contact_email: "hi@fund.com" }),
  );
  assert.equal(out.thesis, "We back seed infra.");
  assert.equal(out.contact_email, "hi@fund.com");
  assert.deepEqual(out.entity_overlay_applied.sort(), ["contact_email", "thesis"]);
});

test("legacy value always wins — the overlay only fills blanks", () => {
  const out = applyOrgOverlay(
    { thesis: "Operator-written thesis", aum_usd: 250 },
    overlayWith({ thesis: "AI-extracted thesis", aum_usd: 999 }),
  );
  assert.equal(out.thesis, "Operator-written thesis");
  assert.equal(out.aum_usd, 250);
  assert.equal(out.entity_overlay_applied, undefined);
});

test("never invents a column the row does not have", () => {
  // accounts has no `thesis` and no `check_size_*`; firms has no `industry`.
  const out = applyOrgOverlay(
    { id: "a1", description: null },
    overlayWith({ thesis: "nope", check_size_min_usd: 10, description: "yes" }),
  );
  assert.equal(out.description, "yes");
  assert.ok(!("thesis" in out), "thesis must not be added to an accounts row");
  assert.ok(!("check_size_min_usd" in out));
});

test("*_json columns receive a JSON STRING, not an array", () => {
  const out = applyOrgOverlay(
    { sectors_json: null, stages_json: null, geo_focus_json: null },
    overlayWith({ sectors: ["fintech", "ai"], stages: ["seed"], geos: ["us"] }),
  );
  // This is the subtlety: firm-detail.js does JSON.parse(firm.stages_json).
  assert.equal(typeof out.sectors_json, "string");
  assert.deepEqual(JSON.parse(out.sectors_json), ["fintech", "ai"]);
  assert.deepEqual(JSON.parse(out.stages_json), ["seed"]);
  assert.deepEqual(JSON.parse(out.geo_focus_json), ["us"]);
});

test('"[]" and unparseable strings count as empty and get filled', () => {
  const out = applyOrgOverlay(
    { sectors_json: "[]", stages_json: "not json" },
    overlayWith({ sectors: ["climate"], stages: ["series-a"] }),
  );
  assert.deepEqual(JSON.parse(out.sectors_json), ["climate"]);
  assert.deepEqual(JSON.parse(out.stages_json), ["series-a"]);
});

test("a populated *_json array is left alone", () => {
  const out = applyOrgOverlay(
    { sectors_json: '["existing"]' },
    overlayWith({ sectors: ["overlay"] }),
  );
  assert.deepEqual(JSON.parse(out.sectors_json), ["existing"]);
});

test("sectors also fill industries_json for companies/accounts", () => {
  const out = applyOrgOverlay(
    { industries_json: null },
    overlayWith({ sectors: ["saas"] }),
  );
  assert.deepEqual(JSON.parse(out.industries_json), ["saas"]);
});

// ---- loadOrgEntityOverlay ----------------------------------------------

test("no entity mapping → empty overlay, never a throw", async () => {
  const o = await loadOrgEntityOverlay(mockEnv({}), "firms", 42);
  assert.equal(o.thesis, null);
  assert.deepEqual(o.sectors, []);
});

test("reads facts, including both HQ predicate families", async () => {
  // entities/dualwrite.ts writes `city`/`country_iso2`; ai/profileFiller.ts
  // writes `headquarters_city`/`headquarters_country` for the same concept.
  const env = mockEnv({
    ...MAP,
    "FROM facts": [
      { predicate: "thesis", value_text: "Seed-stage infra.", value_number: null },
      { predicate: "headquarters_city", value_text: "Berlin", value_number: null },
      { predicate: "country_iso2", value_text: "DE", value_number: null },
      { predicate: "aum_usd", value_text: null, value_number: 120000000 },
      { predicate: "contact_email", value_text: "team@fund.vc", value_number: null },
    ],
  });
  const o = await loadOrgEntityOverlay(env, "firms", 7);
  assert.equal(o.thesis, "Seed-stage infra.");
  assert.equal(o.hq_city, "Berlin");
  assert.equal(o.hq_country_iso2, "DE");
  assert.equal(o.aum_usd, 120000000);
  assert.equal(o.contact_email, "team@fund.vc");
});

test("mission/description/bio all land in description", async () => {
  const env = mockEnv({
    ...MAP,
    "FROM facts": [{ predicate: "mission", value_text: "Fund the frontier.", value_number: null }],
  });
  const o = await loadOrgEntityOverlay(env, "companies", 3);
  assert.equal(o.description, "Fund the frontier.");
});

test("entity_summary CSVs become arrays", async () => {
  const env = mockEnv({
    ...MAP,
    entity_summary: {
      primary_role: "firm", country_iso2: "US", region: null, city: "SF",
      sectors_csv: "ai, fintech", stages_csv: "seed", geos_csv: "us,ca",
      check_size_min_usd: 100000, check_size_max_usd: 2000000,
      primary_email: null, primary_linkedin: null, primary_domain: "fund.vc",
    },
  });
  const o = await loadOrgEntityOverlay(env, "firms", 9);
  assert.deepEqual(o.sectors, ["ai", "fintech"]);
  assert.deepEqual(o.geos, ["us", "ca"]);
  assert.equal(o.hq_city, "SF");
  assert.equal(o.check_size_min_usd, 100000);
  assert.equal(o.domain, "fund.vc");
});

test("a DB failure degrades to an empty overlay rather than throwing", async () => {
  const env = {
    DB: { prepare() { throw new Error("no such table: entity_legacy_map"); } },
  };
  const o = await loadOrgEntityOverlay(env, "accounts", "x");
  assert.equal(o.thesis, null);
  assert.deepEqual(o.stages, []);
});
