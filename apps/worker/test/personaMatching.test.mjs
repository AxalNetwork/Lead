// Task #8: unit tests for the persona ↔ entity matching scorers.
//
// These cover the pure scoring primitives (no D1 / Env / AI), the
// per-component invariants from the task spec, and the aggregation
// math. The orchestrator paths (loadPersonEntity, scoreBatch,
// upsertMatch, trigger debounce, route handlers) require D1 and are
// covered by the in-worker integration test suite.

import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = "../test-dist";
const m = await import(`${ROOT}/services/personaMatchingScorers.js`);

const {
  DEFAULT_WEIGHTS, MODEL_VERSION,
  scoreSeniority, scoreFunction, scoreIndustry, scoreCompanySize,
  scoreStage, scoreGeo, haversineKm, cosine, aggregate, extractTargets, buildRationale,
} = m;

test("weights sum to 1.0", () => {
  const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights must sum to 1.0, got ${sum}`);
  assert.equal(MODEL_VERSION, "v1");
});

test("seniority ladder: exact / adjacent / two-away / unrelated", () => {
  assert.equal(scoreSeniority("founder", ["founder"]).value, 1.0);
  // founder ↔ cxo are adjacent on the ladder.
  assert.equal(scoreSeniority("founder", ["cxo"]).value, 0.6);
  // founder ↔ svp are two away.
  assert.equal(scoreSeniority("founder", ["svp"]).value, 0.2);
  // founder ↔ ic are far apart.
  assert.equal(scoreSeniority("founder", ["ic"]).value, 0);
  // No data ⇒ 0.
  assert.equal(scoreSeniority(null, ["founder"]).value, 0);
  assert.equal(scoreSeniority("founder", []).value, 0);
  // Unknown token ⇒ 0.
  assert.equal(scoreSeniority("wizard", ["founder"]).value, 0);
});

test("function Jaccard: exact, partial, none", () => {
  assert.ok(scoreFunction("engineering", ["engineering"]).value >= 0.99);
  // Partial overlap "data engineering" vs "engineering".
  assert.ok(scoreFunction("data engineering", ["engineering"]).value > 0);
  assert.ok(scoreFunction("data engineering", ["engineering"]).value < 1.0);
  // Disjoint.
  assert.equal(scoreFunction("legal", ["engineering"]).value, 0);
  assert.equal(scoreFunction(null, ["engineering"]).value, 0);
});

test("industry: exact + parent-industry fallback", () => {
  assert.equal(scoreIndustry(["software"], ["software"]).value, 1.0);
  // fintech ⊂ finance per parent map.
  assert.equal(scoreIndustry(["fintech"], ["finance"]).value, 0.7);
  // edtech ⊂ education.
  assert.equal(scoreIndustry(["edtech"], ["education"]).value, 0.7);
  // No relationship.
  assert.equal(scoreIndustry(["agriculture"], ["software"]).value, 0);
  assert.equal(scoreIndustry([], ["software"]).value, 0);
});

test("company_size: in-band / adjacent / outside", () => {
  // Series-A band 11..50.
  assert.equal(scoreCompanySize(25, 11, 50).value, 1.0);
  assert.equal(scoreCompanySize(11, 11, 50).value, 1.0);
  assert.equal(scoreCompanySize(50, 11, 50).value, 1.0);
  // Adjacent: 25% above ceiling.
  const adj = scoreCompanySize(60, 11, 50).value;
  assert.equal(adj, 0.5);
  // Way outside.
  assert.equal(scoreCompanySize(5000, 11, 50).value, 0);
  // Missing data.
  assert.equal(scoreCompanySize(null, 11, 50).value, 0);
  assert.equal(scoreCompanySize(25, null, null).value, 0);
});

test("stage ladder: exact / adjacent / unrelated", () => {
  assert.equal(scoreStage(["series_a"], ["series_a"]).value, 1.0);
  assert.equal(scoreStage(["seed"], ["series_a"]).value, 0.6);
  assert.equal(scoreStage(["series_b"], ["series_a"]).value, 0.6);
  assert.equal(scoreStage(["public"], ["seed"]).value, 0);
  // Spelling variants normalized.
  assert.equal(scoreStage(["Series A"], ["series_a"]).value, 1.0);
  assert.equal(scoreStage(["series-a"], ["series_a"]).value, 1.0);
  assert.equal(scoreStage([], ["seed"]).value, 0);
});

test("haversine distance: NYC ↔ SF ≈ 4100km", () => {
  const d = haversineKm(40.7128, -74.0060, 37.7749, -122.4194);
  assert.ok(d > 4000 && d < 4200, `NYC↔SF should be ~4129km, got ${d}`);
  // Identity = 0.
  assert.equal(haversineKm(40, -74, 40, -74), 0);
});

test("geo Haversine + exp decay: NYC persona, 50km radius", () => {
  // Persona centered on NYC with 50km radius.
  const center = { centerLat: 40.7128, centerLng: -74.0060, radiusKm: 50, targets: ["us"], entityIso2: "us" };
  // NYC entity ⇒ ~1.0 (d≈0).
  const nyc = scoreGeo({ ...center, entityLat: 40.7128, entityLng: -74.0060 });
  assert.ok(nyc.value > 0.99, `NYC@NYC should be ~1, got ${nyc.value}`);
  // Jersey City (~5km from NYC) ⇒ exp(-5/50) ≈ 0.905.
  const jc = scoreGeo({ ...center, entityLat: 40.7178, entityLng: -74.0431 });
  assert.ok(jc.value > 0.85 && jc.value < 0.95, `Jersey City should be ~0.9, got ${jc.value}`);
  // SF (4100km) ⇒ exp(-4100/50) ≈ 0.
  const sf = scoreGeo({ ...center, entityLat: 37.7749, entityLng: -122.4194 });
  assert.ok(sf.value < 0.01, `SF should be ~0 (far outside radius), got ${sf.value}`);
});

test("geo ISO2 fallback when coordinates missing", () => {
  // No persona center, no entity coords ⇒ ISO2 match path.
  const same = scoreGeo({ entityIso2: "us", targets: ["us"] });
  assert.equal(same.value, 1.0);
  // Continent fallback: CA + US share NA.
  const continent = scoreGeo({ entityIso2: "ca", targets: ["us"] });
  assert.equal(continent.value, 0.5);
  // Different continent.
  const far = scoreGeo({ entityIso2: "jp", targets: ["us"] });
  assert.equal(far.value, 0);
  // Missing data.
  assert.equal(scoreGeo({ entityIso2: null, targets: ["us"] }).value, 0);
});

test("cosine: identity / orthogonal / parallel", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [2, 2]) - 1) < 1e-9);
  // Length mismatch / empty.
  assert.equal(cosine([1, 2], [1]), 0);
  assert.equal(cosine([], []), 0);
});

test("aggregate: weighted average matches spec weights", () => {
  // All components = 1.0 ⇒ aggregate = 1.0.
  const all = (v) => ({ value: v, weight: DEFAULT_WEIGHTS, reason: "" });
  const components = {
    title_sim:    { value: 1, weight: DEFAULT_WEIGHTS.title_sim,    reason: "" },
    seniority:    { value: 1, weight: DEFAULT_WEIGHTS.seniority,    reason: "" },
    function:     { value: 1, weight: DEFAULT_WEIGHTS.function,     reason: "" },
    industry:     { value: 1, weight: DEFAULT_WEIGHTS.industry,     reason: "" },
    company_size: { value: 1, weight: DEFAULT_WEIGHTS.company_size, reason: "" },
    stage:        { value: 1, weight: DEFAULT_WEIGHTS.stage,        reason: "" },
    geo:          { value: 1, weight: DEFAULT_WEIGHTS.geo,          reason: "" },
  };
  assert.ok(Math.abs(aggregate(components) - 1.0) < 1e-9);
  // Only title_sim full, rest zero ⇒ 0.25.
  for (const k of Object.keys(components)) if (k !== "title_sim") components[k].value = 0;
  assert.ok(Math.abs(aggregate(components) - 0.25) < 1e-9);
  void all;
});

test("extractTargets: parses persona row JSON columns correctly", () => {
  const row = {
    name: "Series-A B2B SaaS founder in NYC",
    thesis: "Vertical SaaS for the trades",
    buyer_titles_json: '["founder","ceo"]',
    buyer_seniority_json: '["founder","cxo"]',
    buyer_departments_json: '["product","engineering"]',
    industries_json: '["saas","software"]',
    size_min: 11,
    size_max: 50,
    geos_json: '["us"]',
    hard_filters_json: JSON.stringify({ stages: ["series_a"], geo_center: { lat: 40.7128, lng: -74.0060, radius_km: 50 } }),
  };
  const t = extractTargets(row);
  assert.deepEqual(t.titles, ["founder", "ceo"]);
  assert.deepEqual(t.stages, ["series_a"]);
  assert.equal(t.size_min, 11);
  assert.equal(t.size_max, 50);
  assert.equal(t.geo_center_lat, 40.7128);
  assert.equal(t.geo_radius_km, 50);
  assert.ok(t.title_text.includes("founder"));
  // Task #8 spec: thesis (long-form notes) must NOT contribute to
  // title_sim — embed text is restricted to structured target fields.
  assert.ok(!t.title_text.includes("Vertical SaaS"));
  assert.ok(t.title_text.includes("Seniority"));
  assert.ok(t.title_text.includes("Function"));
});

test("end-to-end ranking: Series-A SaaS founder beats VP Sales beats Senior Engineer at Bank", () => {
  // Persona: "Series-A B2B SaaS founder in NYC".
  const persona = {
    name: "Series-A B2B SaaS founder in NYC",
    thesis: "B2B SaaS founders in the NYC metro raising Series A.",
    buyer_titles_json: '["founder","ceo"]',
    buyer_seniority_json: '["founder"]',
    buyer_departments_json: '["product","engineering"]',
    industries_json: '["saas","software"]',
    size_min: 11, size_max: 50,
    geos_json: '["us"]',
    hard_filters_json: JSON.stringify({ stages: ["series_a"], geo_center: { lat: 40.7128, lng: -74.0060, radius_km: 50 } }),
  };
  const targets = extractTargets(persona);
  // Compute non-title components for three synthetic candidates and
  // assert the aggregate ranking — title_sim is set to a fixed value
  // since the embedding model isn't reachable here. (The deterministic
  // components alone are enough to separate these archetypes.)
  function scoreCandidate(c, titleSim) {
    const components = {
      title_sim:    { value: titleSim, weight: DEFAULT_WEIGHTS.title_sim, reason: "" },
      seniority:    scoreSeniority(c.seniority, targets.seniority),
      function:     scoreFunction(c.department, targets.functions),
      industry:     scoreIndustry(c.employer_sectors, targets.industries),
      company_size: scoreCompanySize(c.employer_employees, targets.size_min, targets.size_max),
      stage:        scoreStage(c.employer_stages, targets.stages),
      geo:          scoreGeo({
        entityIso2: c.country_iso2, entityLat: c.lat, entityLng: c.lng,
        targets: targets.geos, centerLat: targets.geo_center_lat,
        centerLng: targets.geo_center_lng, radiusKm: targets.geo_radius_km,
      }),
    };
    return aggregate(components);
  }
  // Strong match: NYC SaaS founder, ~30 ppl, Series A.
  const founder = scoreCandidate({
    seniority: "founder", department: "engineering",
    employer_sectors: ["saas"], employer_employees: 30, employer_stages: ["series_a"],
    country_iso2: "us", lat: 40.7128, lng: -74.0060,
  }, 0.85);
  // Mid match: VP Sales, ~30 ppl, Series A, NYC.
  const vpSales = scoreCandidate({
    seniority: "vp", department: "sales",
    employer_sectors: ["saas"], employer_employees: 30, employer_stages: ["series_a"],
    country_iso2: "us", lat: 40.7128, lng: -74.0060,
  }, 0.4);
  // Weak match: Senior engineer at giant bank in Tokyo.
  const banker = scoreCandidate({
    seniority: "director", department: "engineering",
    employer_sectors: ["finance"], employer_employees: 100000, employer_stages: ["public"],
    country_iso2: "jp", lat: 35.68, lng: 139.69,
  }, 0.3);
  assert.ok(founder > vpSales, `founder (${founder}) should beat VP Sales (${vpSales})`);
  assert.ok(vpSales > banker, `VP Sales (${vpSales}) should beat Tokyo banker (${banker})`);
  // Strong match should clear a 0.5 ranking threshold; banker shouldn't.
  assert.ok(founder > 0.5, `founder should clear 0.5, got ${founder}`);
  assert.ok(banker < 0.4, `banker should be below 0.4, got ${banker}`);
});

test("rationale string includes persona name and percentage", () => {
  const components = {
    title_sim:    { value: 0.8, weight: DEFAULT_WEIGHTS.title_sim,    reason: "title cosine 0.800" },
    seniority:    { value: 1.0, weight: DEFAULT_WEIGHTS.seniority,    reason: "exact seniority match" },
    function:     { value: 0,   weight: DEFAULT_WEIGHTS.function,     reason: "no overlap" },
    industry:     { value: 1.0, weight: DEFAULT_WEIGHTS.industry,     reason: "industry matches" },
    company_size: { value: 0,   weight: DEFAULT_WEIGHTS.company_size, reason: "unknown" },
    stage:        { value: 0,   weight: DEFAULT_WEIGHTS.stage,        reason: "unknown" },
    geo:          { value: 1.0, weight: DEFAULT_WEIGHTS.geo,          reason: "geo matches" },
  };
  const r = buildRationale("Persona X", "Jane Doe", "Acme Corp", components, aggregate(components));
  assert.match(r, /Jane Doe/);
  assert.match(r, /Acme Corp/);
  assert.match(r, /Persona X/);
  assert.match(r, /\d+%/);
});
