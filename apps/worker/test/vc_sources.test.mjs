// Task #3: VC Source Registry — contract + selector tests.
//
// Hermetic: stubs env.DB with an in-memory query log so we can assert
// SQL shape + parameter binding without a live D1. Also file-scans the
// migration SQL so the seeded catalog stays in spec.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_WORKER = join(__dirname, "..");

const SCHEMA_SQL = readFileSync(join(REPO_WORKER, "migrations/347_vc_sources.sql"), "utf8");
const SEED_SQL = readFileSync(join(REPO_WORKER, "migrations/348_seed_vc_sources.sql"), "utf8");

// ---- migration 347: schema contract -----------------------------------------
test("347 schema: vc_sources has every spec'd column", () => {
  const required = [
    "id", "jurisdiction", "authority", "data_type", "source_name", "base_url",
    "access_pattern", "refresh_cadence", "authentication", "auth_notes",
    "historical_depth", "data_fields_json", "seed_url_template", "enabled",
    "priority", "last_crawled_at", "last_success_at",
  ];
  for (const col of required) {
    assert.ok(SCHEMA_SQL.includes(col), `column ${col} missing from 347_vc_sources.sql`);
  }
});

test("347 schema: indexes for lookup + health views exist", () => {
  assert.ok(/CREATE INDEX[^;]+idx_vcs_lookup[^;]+data_type[^;]+priority DESC/i.test(SCHEMA_SQL.replace(/\n/g, " ")), "lookup index missing");
  assert.ok(/CREATE INDEX[^;]+idx_vcs_health[^;]+enabled[^;]+last_success_at/i.test(SCHEMA_SQL.replace(/\n/g, " ")), "health index missing");
});

test("347 schema: UNIQUE (authority, source_name) lets seeding be idempotent", () => {
  const oneLine = SCHEMA_SQL.replace(/\s+/g, " ");
  assert.match(oneLine, /UNIQUE\s*\(\s*authority\s*,\s*source_name\s*\)/i);
});

// ---- migration 348: seed catalog --------------------------------------------
test("348 seed: catalog has ≥120 sources across all five tiers", () => {
  const rows = (SEED_SQL.match(/^\s*\('src_/gm) ?? []).length;
  assert.ok(rows >= 120, `expected ≥120 seeded sources, got ${rows}`);
});

test("348 seed: SEC EDGAR core forms all present at priority 100", () => {
  // Forms ADV / D / 13F / 13D / 13G / 4 / S-1 / 8-K / 10-K / 10-Q + IRS 990.
  const requiredIds = [
    "src_sec_form_adv", "src_sec_form_d", "src_sec_form_13f",
    "src_sec_sched_13d", "src_sec_sched_13g", "src_sec_form_4",
    "src_sec_form_s1", "src_sec_form_8k", "src_sec_form_10k",
    "src_sec_form_10q", "src_irs_form_990",
  ];
  for (const id of requiredIds) {
    assert.ok(SEED_SQL.includes(`'${id}'`), `seed missing required source ${id}`);
  }
});

test("348 seed: Form ADV declares aum_usd among its data_fields", () => {
  const idx = SEED_SQL.indexOf("'src_sec_form_adv'");
  const segment = SEED_SQL.slice(idx, idx + 1200);
  assert.match(segment, /"aum_usd"/);
  assert.match(segment, /"gp_persons"/);
  assert.match(segment, /"fee_structure"/);
});

test("348 seed: state pension tier covers spec'd state systems", () => {
  for (const id of [
    "src_pen_calpers", "src_pen_calstrs", "src_pen_opers", "src_pen_nyscrf",
    "src_pen_wasib", "src_pen_oregon", "src_pen_texas_trs", "src_pen_swib",
    "src_pen_prim", "src_pen_ncrsd", "src_pen_nj", "src_pen_imrf",
    "src_pen_vrs", "src_pen_fsba", "src_pen_mi_ors",
  ]) {
    assert.ok(SEED_SQL.includes(`'${id}'`), `seed missing state pension ${id}`);
  }
});

test("348 seed: international regulators tier covers spec'd jurisdictions", () => {
  for (const id of [
    "src_uk_ch", "src_uk_fca", "src_sg_mas", "src_sg_acra", "src_il_isa",
    "src_cn_amac", "src_in_sebi", "src_in_mca", "src_ca_csa", "src_hk_sfc",
    "src_eu_esma", "src_eu_de_bafin", "src_eu_fr_amf", "src_eu_it_consob",
    "src_eu_es_cnmv",
  ]) {
    assert.ok(SEED_SQL.includes(`'${id}'`), `seed missing international source ${id}`);
  }
});

test("348 seed: idempotent — every INSERT uses INSERT OR REPLACE", () => {
  const inserts = SEED_SQL.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+vc_sources/gi) ?? [];
  const orReplace = SEED_SQL.match(/INSERT\s+OR\s+REPLACE\s+INTO\s+vc_sources/gi) ?? [];
  assert.ok(inserts.length > 0, "seed has no INSERTs");
  assert.equal(inserts.length, orReplace.length, "every seed INSERT must be INSERT OR REPLACE");
});

// ---- services/sourceSelector.ts contract ------------------------------------
const { selectSourcesFor, selectBestSourceFor } = await import("../test-dist/services/sourceSelector.js");

function makeEnv(rows) {
  const queries = [];
  return {
    queries,
    DB: {
      prepare(sql) {
        const q = { sql, binds: [] };
        queries.push(q);
        return {
          bind(...args) { q.binds = args; return this; },
          async first() { return rows[0] ?? null; },
          async all() { return { results: rows }; },
          async run() { return { meta: { changes: rows.length } }; },
        };
      },
    },
  };
}

test("selectSourcesFor: filters by data_type + jurisdiction and sorts priority DESC", async () => {
  const env = makeEnv([
    { id: "a", jurisdiction: "us-federal", authority: "SEC", data_type: "fund_registration", source_name: "Form ADV", base_url: "x", access_pattern: "json_api", refresh_cadence: "quarterly", authentication: "user_agent", auth_notes: null, historical_depth: null, data_fields_json: '["aum_usd","gp_persons"]', seed_url_template: null, enabled: 1, priority: 100, last_crawled_at: null, last_success_at: null, notes: null },
  ]);
  const rows = await selectSourcesFor(env, { data_type: "fund_registration", jurisdiction: "us-federal" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "a");
  assert.deepEqual(rows[0].data_fields, ["aum_usd", "gp_persons"]);
  // SQL shape: priority DESC must be in the ORDER BY.
  const sql = env.queries[0].sql;
  assert.match(sql, /enabled = 1/);
  assert.match(sql, /data_type = \?/);
  assert.match(sql, /jurisdiction = \?/);
  assert.match(sql, /ORDER BY priority DESC/);
  // Binds: data_type, jurisdiction, limit.
  assert.deepEqual(env.queries[0].binds.slice(0, 2), ["fund_registration", "us-federal"]);
});

test("selectSourcesFor: yields_field post-filter excludes sources missing the field", async () => {
  const env = makeEnv([
    { id: "a", jurisdiction: "us-federal", authority: "SEC", data_type: "fund_registration", source_name: "Form ADV", base_url: "x", access_pattern: "json_api", refresh_cadence: "quarterly", authentication: "user_agent", auth_notes: null, historical_depth: null, data_fields_json: '["aum_usd"]', seed_url_template: null, enabled: 1, priority: 100, last_crawled_at: null, last_success_at: null, notes: null },
    { id: "b", jurisdiction: "us-federal", authority: "SEC", data_type: "fund_registration", source_name: "Form D",   base_url: "x", access_pattern: "json_api", refresh_cadence: "daily",     authentication: "user_agent", auth_notes: null, historical_depth: null, data_fields_json: '["investor_count"]', seed_url_template: null, enabled: 1, priority: 100, last_crawled_at: null, last_success_at: null, notes: null },
  ]);
  const rows = await selectSourcesFor(env, { data_type: "fund_registration", yields_field: "aum_usd" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "a");
});

test("selectBestSourceFor: returns null when nothing matches", async () => {
  const env = makeEnv([]);
  const r = await selectBestSourceFor(env, { data_type: "nope" });
  assert.equal(r, null);
});

test("selectSourcesFor: short-circuits on empty data_type", async () => {
  const env = makeEnv([]);
  const r = await selectSourcesFor(env, { data_type: "" });
  assert.deepEqual(r, []);
  assert.equal(env.queries.length, 0, "must not hit D1 when data_type is empty");
});

test("selectBestSourceFor: yields_field falls through to lower-priority match (regression: limit-before-filter)", async () => {
  // Priority 100 source lacks aum_usd; priority 90 source has it.
  // Before fix: SQL LIMIT 1 returned only the priority-100 row, post-filter
  // dropped it, and the function returned null even though a match exists.
  const env = makeEnv([
    { id: "top", jurisdiction: "us", authority: "X", data_type: "fund_registration", source_name: "Top", base_url: "x", access_pattern: "api", refresh_cadence: "d", authentication: "none", auth_notes: null, historical_depth: null, data_fields_json: '["other"]',    seed_url_template: null, enabled: 1, priority: 100, last_crawled_at: null, last_success_at: null, notes: null },
    { id: "mid", jurisdiction: "us", authority: "Y", data_type: "fund_registration", source_name: "Mid", base_url: "x", access_pattern: "api", refresh_cadence: "d", authentication: "none", auth_notes: null, historical_depth: null, data_fields_json: '["aum_usd"]', seed_url_template: null, enabled: 1, priority:  90, last_crawled_at: null, last_success_at: null, notes: null },
  ]);
  const best = await selectBestSourceFor(env, { data_type: "fund_registration", yields_field: "aum_usd" });
  assert.ok(best, "expected a fallback match");
  assert.equal(best.id, "mid");
  // SQL bound a wide candidate pool, not LIMIT 1.
  const lastBind = env.queries[0].binds.at(-1);
  assert.ok(Number(lastBind) >= 50, `expected wide SQL LIMIT when yields_field set, got ${lastBind}`);
});

test("selectSourcesFor: yields_field respects requested limit after post-filter", async () => {
  const env = makeEnv([
    { id: "a", jurisdiction: "us", authority: "A", data_type: "t", source_name: "A", base_url: "x", access_pattern: "api", refresh_cadence: "d", authentication: "none", auth_notes: null, historical_depth: null, data_fields_json: '["aum_usd"]', seed_url_template: null, enabled: 1, priority: 100, last_crawled_at: null, last_success_at: null, notes: null },
    { id: "b", jurisdiction: "us", authority: "B", data_type: "t", source_name: "B", base_url: "x", access_pattern: "api", refresh_cadence: "d", authentication: "none", auth_notes: null, historical_depth: null, data_fields_json: '["aum_usd"]', seed_url_template: null, enabled: 1, priority:  90, last_crawled_at: null, last_success_at: null, notes: null },
    { id: "c", jurisdiction: "us", authority: "C", data_type: "t", source_name: "C", base_url: "x", access_pattern: "api", refresh_cadence: "d", authentication: "none", auth_notes: null, historical_depth: null, data_fields_json: '["aum_usd"]', seed_url_template: null, enabled: 1, priority:  80, last_crawled_at: null, last_success_at: null, notes: null },
  ]);
  const rows = await selectSourcesFor(env, { data_type: "t", yields_field: "aum_usd", limit: 2 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
});

test("selectSourcesFor: ORDER BY tiebreaks on last_success_at DESC after priority DESC", async () => {
  const env = makeEnv([]);
  await selectSourcesFor(env, { data_type: "t" });
  const sql = env.queries[0].sql.replace(/\s+/g, " ");
  assert.match(sql, /ORDER BY priority DESC/);
  assert.match(sql, /last_success_at DESC/);
  // Nulls-last guard.
  assert.match(sql, /CASE WHEN last_success_at IS NULL/);
});

test("selectSourcesFor: malformed data_fields_json degrades to empty array, never throws", async () => {
  const env = makeEnv([
    { id: "a", jurisdiction: "us-federal", authority: "SEC", data_type: "fund_registration", source_name: "X", base_url: "x", access_pattern: "json_api", refresh_cadence: "quarterly", authentication: "user_agent", auth_notes: null, historical_depth: null, data_fields_json: "{not json", seed_url_template: null, enabled: 1, priority: 100, last_crawled_at: null, last_success_at: null, notes: null },
  ]);
  const rows = await selectSourcesFor(env, { data_type: "fund_registration" });
  assert.deepEqual(rows[0].data_fields, []);
});
