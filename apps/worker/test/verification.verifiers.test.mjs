// Task #14: per-verifier fixture tests.
//
// Exercises each of the six verifiers against a minimal in-memory env
// stub. For network-backed verifiers (litigation / bankruptcy /
// directorship) we drive the "no credentials configured" branch so we
// don't rely on a real CourtListener / Companies House response —
// per-source happy paths are covered by integration tests separately.

import { test } from "node:test";
import assert from "node:assert/strict";

const { educationVerifier } = await import("../test-dist/services/verification/verifiers/education.js");
const { employmentVerifier } = await import("../test-dist/services/verification/verifiers/employment.js");
const { priorStartupVerifier } = await import("../test-dist/services/verification/verifiers/priorStartup.js");
const { litigationVerifier } = await import("../test-dist/services/verification/verifiers/litigation.js");
const { bankruptcyVerifier } = await import("../test-dist/services/verification/verifiers/bankruptcy.js");
const { directorshipVerifier } = await import("../test-dist/services/verification/verifiers/directorship.js");

function makeEnv(overrides = {}) {
  // Optional source tables that several verifiers consult — empty by
  // default so we drive the "no signal" branches deterministically.
  const tables = {
    deal_events: [],
    sec_form_d_rounds: [],
    opencorporates_status: [],
    sec_form4_insiders: [],
    firm_team_snapshots: [],
    entity_mentions: [],
    sec_director_filings: [],
    facts: [],
    ...overrides.tables,
  };
  function match(sql, args) {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/FROM deal_events.*IN \('acquisition','ipo','spac'\)/.test(s)) {
      return tables.deal_events.filter((r) => r.company_entity_id === args[0] && ["acquisition","ipo","spac"].includes(r.event_type));
    }
    if (/FROM deal_events WHERE company_entity_id = \? ORDER BY announcement_date DESC LIMIT 1/.test(s)) {
      return tables.deal_events.filter((r) => r.company_entity_id === args[0]).sort((a,b) => (b.occurred_at||"").localeCompare(a.occurred_at||""));
    }
    if (/FROM sec_form_d_rounds/.test(s)) {
      return tables.sec_form_d_rounds.filter((r) => r.entity_id === args[0]);
    }
    if (/FROM opencorporates_status/.test(s)) {
      return tables.opencorporates_status.filter((r) => r.entity_id === args[0]);
    }
    if (/FROM sec_director_filings/.test(s)) {
      return tables.sec_director_filings.filter((r) => r.person_entity_id === args[0] && r.issuer_entity_id === args[1]);
    }
    if (/FROM facts WHERE entity_id = \? AND predicate = 'firm.companies_house_number'/.test(s)) {
      return tables.facts.filter((r) => r.entity_id === args[0] && r.predicate === "firm.companies_house_number");
    }
    if (/FROM entity_mentions/.test(s)) return tables.entity_mentions;
    if (/FROM sec_form4_insiders/.test(s) || /FROM firm_team_snapshots/.test(s)) return [];
    return [];
  }
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() { const r = match(sql, args); return r[0] ?? null; },
              async all() { return { results: match(sql, args) }; },
              async run() { return { meta: { changes: 0 } }; },
            };
          },
        };
      },
    },
    SCRAPE_CACHE: { async get() { return null; }, async put() {} },
    ...overrides.env,
  };
}

test("educationVerifier.supports matches person.education only", () => {
  assert.equal(educationVerifier.supports({ predicate: "person.education", value_hash: "", summary: "", payload: {} }), true);
  assert.equal(educationVerifier.supports({ predicate: "person.career_entry", value_hash: "", summary: "", payload: {} }), false);
});

test("educationVerifier returns unverifiable when person_name missing", async () => {
  const env = makeEnv();
  const r = await educationVerifier.verify(env, "p", { predicate: "person.education", value_hash: "", summary: "", payload: { institution: "MIT" } });
  assert.equal(r.status, "unverifiable");
});

test("employmentVerifier.supports matches person.career_entry only", () => {
  assert.equal(employmentVerifier.supports({ predicate: "person.career_entry", value_hash: "", summary: "", payload: {} }), true);
  assert.equal(employmentVerifier.supports({ predicate: "person.education", value_hash: "", summary: "", payload: {} }), false);
});

test("employmentVerifier returns unverifiable with no source rows", async () => {
  const env = makeEnv();
  const r = await employmentVerifier.verify(env, "p", { predicate: "person.career_entry", value_hash: "", summary: "", payload: { organization_entity_id: "org1", organization_name: "Acme" } });
  assert.equal(r.status, "unverifiable");
});

test("priorStartupVerifier detects exit:acquired from deal_events", async () => {
  const env = makeEnv({ tables: { deal_events: [
    { company_entity_id: "c1", event_type: "acquisition", source_url: "https://ex/a", evidence_url: "https://ex/a", announcement_date: "2022-01-01", occurred_at: "2022-01-01" },
  ] } });
  const r = await priorStartupVerifier.verify(env, "p", { predicate: "person.prior_startup", value_hash: "", summary: "", payload: { company_entity_id: "c1", claimed_outcome: "acquired" } });
  assert.equal(r.status, "confirmed");
  assert.equal(r.derived_value_text, "exit:acquisition");
});

test("priorStartupVerifier marks claimed-acquired vs operating as contradicted", async () => {
  const env = makeEnv({ tables: { deal_events: [
    { company_entity_id: "c1", event_type: "funding_round", source_url: "https://ex/f", evidence_url: "https://ex/f", announcement_date: new Date().toISOString().slice(0,10), occurred_at: new Date().toISOString().slice(0,10) },
  ] } });
  const r = await priorStartupVerifier.verify(env, "p", { predicate: "person.prior_startup", value_hash: "", summary: "", payload: { company_entity_id: "c1", claimed_outcome: "acquired" } });
  assert.equal(r.status, "contradicted");
});

test("priorStartupVerifier returns unverifiable when company is unknown", async () => {
  const env = makeEnv();
  const r = await priorStartupVerifier.verify(env, "p", { predicate: "person.prior_startup", value_hash: "", summary: "", payload: { company_entity_id: "nope", claimed_outcome: "exit" } });
  assert.equal(r.status, "unverifiable");
});

test("litigationVerifier returns unverifiable when COURTLISTENER_TOKEN unset", async () => {
  const env = makeEnv();
  const r = await litigationVerifier.verify(env, "p", { predicate: "person.litigation_check", value_hash: "", summary: "", payload: { person_name: "Jane Doe" } });
  assert.equal(r.status, "unverifiable");
  assert.equal(r.reason, "courtlistener_unconfigured");
});

test("bankruptcyVerifier returns unverifiable when no source configured", async () => {
  const env = makeEnv();
  const r = await bankruptcyVerifier.verify(env, "p", { predicate: "person.bankruptcy_check", value_hash: "", summary: "", payload: { person_name: "Jane Doe" } });
  assert.equal(r.status, "unverifiable");
  assert.match(r.reason, /no_bankruptcy_source_configured/);
});

test("bankruptcyVerifier returns confirmed on PACER PCL zero-hit response", async () => {
  const env = makeEnv({ env: { PACER_USER: "u", PACER_PASS: "p" } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("cso-auth")) return new Response(JSON.stringify({ nextGenCSO: "TOK", loginResult: "0" }), { status: 200 });
    if (String(url).includes("pcl-public-api")) return new Response(JSON.stringify({ content: [], pageInfo: { totalElements: 0 } }), { status: 200 });
    return new Response("", { status: 404 });
  };
  try {
    const r = await bankruptcyVerifier.verify(env, "p", { predicate: "person.bankruptcy_check", value_hash: "", summary: "", payload: { person_name: "Jane Doe" } });
    assert.equal(r.status, "confirmed");
    assert.equal(r.reason, "pacer_pcl");
    assert.equal(r.derived_value_text, "0");
  } finally { globalThis.fetch = origFetch; }
});

test("bankruptcyVerifier returns contradicted on PACER PCL hit", async () => {
  const env = makeEnv({ env: { PACER_USER: "u", PACER_PASS: "p" } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("cso-auth")) return new Response(JSON.stringify({ nextGenCSO: "TOK", loginResult: "0" }), { status: 200 });
    if (String(url).includes("pcl-public-api")) return new Response(JSON.stringify({
      content: [{ caseTitle: "In re Doe", caseNumber: "23-12345", courtId: "nysb", dateFiled: "2023-04-01" }],
      pageInfo: { totalElements: 1 },
    }), { status: 200 });
    return new Response("", { status: 404 });
  };
  try {
    const r = await bankruptcyVerifier.verify(env, "p", { predicate: "person.bankruptcy_check", value_hash: "", summary: "", payload: { person_name: "Jane Doe" } });
    assert.equal(r.status, "contradicted");
    assert.equal(r.reason, "pacer_pcl_match");
    assert.equal(r.derived_value_text, "1");
    assert.match(r.evidence_snippet, /In re Doe/);
  } finally { globalThis.fetch = origFetch; }
});

test("bankruptcyVerifier falls back to unverifiable when PACER auth fails and no CourtListener token", async () => {
  const env = makeEnv({ env: { PACER_USER: "u", PACER_PASS: "p" } });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("forbidden", { status: 401 });
  try {
    const r = await bankruptcyVerifier.verify(env, "p", { predicate: "person.bankruptcy_check", value_hash: "", summary: "", payload: { person_name: "Jane Doe" } });
    assert.equal(r.status, "unverifiable");
    assert.match(r.reason, /pacer_auth_failed/);
  } finally { globalThis.fetch = origFetch; }
});

test("directorshipVerifier returns unverifiable when no source backs the claim", async () => {
  const env = makeEnv();
  const r = await directorshipVerifier.verify(env, "p", { predicate: "person.board_seat", value_hash: "", summary: "", payload: { organization_entity_id: "org1", organization_name: "Acme", person_name: "Jane" } });
  assert.equal(r.status, "unverifiable");
  assert.equal(r.reason, "no_disclosure_or_press_or_registry");
});
