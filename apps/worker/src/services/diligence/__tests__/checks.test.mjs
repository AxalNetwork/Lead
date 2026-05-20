// Task #6: per-check branch coverage including needs_human and n/a paths.
//
// Drives each check executor against an in-memory mock D1 stub. The mock
// only implements the queries each check actually issues; unknown queries
// throw so any incidental query surfaces immediately.
import { test } from "node:test";
import assert from "node:assert/strict";

const { CORPORATE_CHECKS } = await import("../../../../test-dist/services/diligence/checks/corporate.js");
const { MARKET_CHECKS } = await import("../../../../test-dist/services/diligence/checks/market.js");
const { PRODUCT_CHECKS } = await import("../../../../test-dist/services/diligence/checks/product.js");
const { TRACTION_CHECKS } = await import("../../../../test-dist/services/diligence/checks/traction.js");
const { TEAM_CHECKS } = await import("../../../../test-dist/services/diligence/checks/team.js");
const { FINANCIAL_CHECKS } = await import("../../../../test-dist/services/diligence/checks/financial.js");
const { IP_CHECKS } = await import("../../../../test-dist/services/diligence/checks/ip.js");
const { REGULATORY_CHECKS } = await import("../../../../test-dist/services/diligence/checks/regulatory.js");

function find(arr, key) {
  const c = arr.find((x) => x.key === key);
  if (!c) throw new Error("missing check " + key);
  return c;
}

// Tiny D1 stub. `facts` is keyed by predicate; everything else is a list.
function makeEnv(opts = {}) {
  const facts = opts.facts || []; // [{entity_id, predicate, value_text, value_number, evidence_url}]
  const tables = opts.tables || {}; // arbitrary table → rows
  function prepare(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      first() {
        if (/SELECT value_text, value_number, value_json, evidence_url FROM facts/.test(s)) {
          const [eid, predicate] = args;
          const hit = facts.find((f) => f.entity_id === eid && f.predicate === predicate);
          return Promise.resolve(hit ? { value_text: hit.value_text ?? null, value_number: hit.value_number ?? null, value_json: hit.value_json ?? null, evidence_url: hit.evidence_url ?? null } : null);
        }
        if (/SELECT SUM\(shares_owned\)/.test(s)) {
          if (!tables.cap_table_rows) throw new Error("cap_table_rows missing");
          const rows = tables.cap_table_rows.filter((r) => r.company_entity_id === args[0]);
          if (!rows.length) return Promise.resolve({ sum_shares: 0, total: 0 });
          return Promise.resolve({ sum_shares: rows.reduce((s, r) => s + r.shares_owned, 0), total: Math.max(...rows.map((r) => r.total_shares_outstanding)) });
        }
        if (/COUNT\(\*\) AS n FROM dd_findings/.test(s)) {
          if (!tables.dd_findings) throw new Error("dd_findings missing");
          const rows = tables.dd_findings.filter((r) => r.entity_id === args[0]);
          return Promise.resolve({ n: rows.length });
        }
        if (/COUNT\(\*\) AS n FROM rel_edges/.test(s)) {
          if (!tables.rel_edges) throw new Error("rel_edges missing");
          return Promise.resolve({ n: tables.rel_edges.length });
        }
        if (/COUNT\(\*\) AS n FROM career_history ch/.test(s)) {
          if (!tables.career_history) throw new Error("career_history missing");
          return Promise.resolve({ n: tables.career_history.length });
        }
        if (/SUM\(CASE WHEN verified = 1 THEN 1 ELSE 0 END\) AS verified/.test(s)) {
          if (!tables.facts_logos) throw new Error("facts_logos missing");
          const total = tables.facts_logos.length;
          const verified = tables.facts_logos.filter((r) => r.verified === 1).length;
          return Promise.resolve({ total, verified });
        }
        if (/COUNT\(\*\) AS n FROM uspto_patents/.test(s)) {
          if (!tables.uspto_patents) throw new Error("uspto_patents missing");
          return Promise.resolve({ n: tables.uspto_patents.length });
        }
        throw new Error("unhandled .first() SQL: " + s);
      },
      all() { throw new Error("unhandled .all() SQL: " + s); },
      run() { return Promise.resolve(); },
    };
  }
  return { DB: { prepare } };
}

const ctx = (env) => ({ env, target_entity_id: "ent_1", triggered_by: "op@x" });

// ---- Corporate ----

test("corporate.delaware_confirmed — needs_human when fact missing", async () => {
  const c = find(CORPORATE_CHECKS, "corporate.delaware_confirmed");
  const r = await c.run.call(c, ctx(makeEnv()));
  assert.equal(r.status, "needs_human");
});

test("corporate.delaware_confirmed — pass when DE", async () => {
  const c = find(CORPORATE_CHECKS, "corporate.delaware_confirmed");
  const env = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "company.state_of_incorp", value_text: "DE", evidence_url: "https://x" }] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "pass");
  assert.ok(r.derived_facts && r.derived_facts[0].predicate === "diligence.corporate.delaware_confirmed");
});

test("corporate.delaware_confirmed — caution when non-DE", async () => {
  const c = find(CORPORATE_CHECKS, "corporate.delaware_confirmed");
  const env = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "company.state_of_incorp", value_text: "CA" }] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "caution");
});

test("corporate.cap_table_sanity — needs_human when table absent", async () => {
  const c = find(CORPORATE_CHECKS, "corporate.cap_table_sanity");
  const r = await c.run.call(c, ctx(makeEnv()));
  assert.equal(r.status, "needs_human");
});

test("corporate.cap_table_sanity — pass on tight match", async () => {
  const c = find(CORPORATE_CHECKS, "corporate.cap_table_sanity");
  const env = makeEnv({ tables: { cap_table_rows: [
    { company_entity_id: "ent_1", shares_owned: 600, total_shares_outstanding: 1000 },
    { company_entity_id: "ent_1", shares_owned: 400, total_shares_outstanding: 1000 },
  ] } });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "pass");
});

test("corporate.cap_table_sanity — fail when drift > 1%", async () => {
  const c = find(CORPORATE_CHECKS, "corporate.cap_table_sanity");
  const env = makeEnv({ tables: { cap_table_rows: [
    { company_entity_id: "ent_1", shares_owned: 700, total_shares_outstanding: 1000 },
  ] } });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "fail");
});

// ---- Market ----

test("market.tam_sam_som_sanity — fail when ordering invalid", async () => {
  const c = find(MARKET_CHECKS, "market.tam_sam_som_sanity");
  const env = makeEnv({ facts: [
    { entity_id: "ent_1", predicate: "market.tam_usd", value_number: 100 },
    { entity_id: "ent_1", predicate: "market.sam_usd", value_number: 200 }, // sam > tam
    { entity_id: "ent_1", predicate: "market.som_usd", value_number: 10 },
  ] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "fail");
});

test("market.tam_sam_som_sanity — needs_human when facts missing", async () => {
  const c = find(MARKET_CHECKS, "market.tam_sam_som_sanity");
  const r = await c.run.call(c, ctx(makeEnv()));
  assert.equal(r.status, "needs_human");
});

// ---- Product ----

test("product.github_cadence — fail when 0 commits", async () => {
  const c = find(PRODUCT_CHECKS, "product.github_cadence");
  const env = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "product.github.commits_90d", value_number: 0 }] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "fail");
});

test("product.github_cadence — pass when ≥12", async () => {
  const c = find(PRODUCT_CHECKS, "product.github_cadence");
  const env = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "product.github.commits_90d", value_number: 30 }] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "pass");
});

// ---- Traction ----

test("traction.reference_customer_reachable — always needs_human (manual)", async () => {
  const c = find(TRACTION_CHECKS, "traction.reference_customer_reachable");
  const r = await c.run.call(c, ctx(makeEnv()));
  assert.equal(r.status, "needs_human");
});

test("traction.concentration_risk — fail at high concentration", async () => {
  const c = find(TRACTION_CHECKS, "traction.concentration_risk");
  const env = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "commercial.top_customer_pct", value_number: 0.6 }] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "fail");
});

// ---- Team ----

test("team.retention — pass at 90%, fail at 50%", async () => {
  const c = find(TEAM_CHECKS, "team.retention");
  const env1 = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "team.retention_pct_12m", value_number: 0.9 }] });
  assert.equal((await c.run.call(c, ctx(env1))).status, "pass");
  const env2 = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "team.retention_pct_12m", value_number: 0.5 }] });
  assert.equal((await c.run.call(c, ctx(env2))).status, "fail");
});

// ---- Financial ----

test("financial.burn_runway — pass when profitable", async () => {
  const c = find(FINANCIAL_CHECKS, "financial.burn_runway");
  const env = makeEnv({ facts: [
    { entity_id: "ent_1", predicate: "financial.net_burn_usd_month", value_number: 0 },
    { entity_id: "ent_1", predicate: "financial.cash_balance_usd", value_number: 1000 },
  ] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "pass");
});

test("financial.burn_runway — fail when <9mo runway", async () => {
  const c = find(FINANCIAL_CHECKS, "financial.burn_runway");
  const env = makeEnv({ facts: [
    { entity_id: "ent_1", predicate: "financial.net_burn_usd_month", value_number: 100 },
    { entity_id: "ent_1", predicate: "financial.cash_balance_usd", value_number: 300 },
  ] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "fail");
});

test("financial.unit_economics — needs_human when zero cac", async () => {
  const c = find(FINANCIAL_CHECKS, "financial.unit_economics");
  const env = makeEnv({ facts: [
    { entity_id: "ent_1", predicate: "commercial.ltv_usd", value_number: 100 },
    { entity_id: "ent_1", predicate: "commercial.cac_usd", value_number: 0 },
  ] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "needs_human");
});

// ---- IP ----

test("ip.patents_owned — caution when none", async () => {
  const c = find(IP_CHECKS, "ip.patents_owned");
  const env = makeEnv({ tables: { uspto_patents: [] } });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "caution");
});

test("ip.patents_owned — needs_human when source table missing", async () => {
  const c = find(IP_CHECKS, "ip.patents_owned");
  const r = await c.run.call(c, ctx(makeEnv()));
  assert.equal(r.status, "needs_human");
});

test("ip.ip_assignment — fail when <50%", async () => {
  const c = find(IP_CHECKS, "ip.ip_assignment");
  const env = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "ip.assignment.founders_signed_pct", value_number: 0.3 }] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "fail");
});

// ---- Regulatory ----

test("regulatory.hipaa — n/a outside healthcare sector", async () => {
  const c = find(REGULATORY_CHECKS, "regulatory.hipaa");
  const env = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "company.primary_sector", value_text: "saas" }] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "n/a");
});

test("regulatory.hipaa — needs_human in healthcare without attestation", async () => {
  const c = find(REGULATORY_CHECKS, "regulatory.hipaa");
  const env = makeEnv({ facts: [{ entity_id: "ent_1", predicate: "company.primary_sector", value_text: "healthcare" }] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "needs_human");
});

test("regulatory.hipaa — pass when attested", async () => {
  const c = find(REGULATORY_CHECKS, "regulatory.hipaa");
  const env = makeEnv({ facts: [
    { entity_id: "ent_1", predicate: "company.primary_sector", value_text: "healthcare" },
    { entity_id: "ent_1", predicate: "regulatory.hipaa_attested", value_text: "true" },
  ] });
  const r = await c.run.call(c, ctx(env));
  assert.equal(r.status, "pass");
});
