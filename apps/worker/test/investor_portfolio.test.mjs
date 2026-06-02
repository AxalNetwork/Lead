// Task #31 — tests for the investor portfolio materializer + entity overlay.
//
// Boots an in-memory SQLite (node:sqlite, Node 22+) with trimmed schemas
// matching only the columns the modules under test touch, then exercises:
//   * resolveCompanyId: domain/slug dedupe + create-when-missing
//   * materializeInvestorPortfolio: firm-level + partner + angel rows,
//     idempotency (state-convergent re-run), single-investor scoping,
//     and preservation of non-derived (imported) rows
//   * loadInvestorEntityOverlay + coalesce helpers: entity-store fallback

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const ROOT = "../test-dist";
const { resolveCompanyId, materializeInvestorPortfolio } = await import(`${ROOT}/services/investor_portfolio.js`);
const { loadInvestorEntityOverlay, coalesceStr, coalesceNum, coalesceArr } = await import(`${ROOT}/services/investor_entity_merge.js`);

// ---- D1-faithful env shim. bind() returns a NEW immutable statement (like
// real D1) so `rows.map(r => stmt.bind(...))` produces distinct statements;
// run() exposes meta.last_row_id; batch() runs each statement in order.
function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      domain TEXT,
      source_url TEXT,
      imported_from TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE investor_investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investor_lead_id TEXT,
      firm_id INTEGER,
      company_id INTEGER NOT NULL,
      stage TEXT,
      amount_usd INTEGER,
      is_lead INTEGER DEFAULT 0,
      invested_at TEXT,
      source_url TEXT,
      source_provider TEXT,
      created_at TEXT
    );
    CREATE TABLE firm_portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      firm_id INTEGER NOT NULL,
      company_name TEXT NOT NULL,
      company_domain TEXT,
      investment_year INTEGER,
      stage TEXT,
      amount_usd INTEGER,
      is_lead INTEGER DEFAULT 0,
      source_url TEXT
    );
    CREATE TABLE firm_people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      firm_id INTEGER NOT NULL,
      lead_id TEXT NOT NULL,
      role TEXT,
      ended_at TEXT
    );
    CREATE TABLE leads (
      id TEXT PRIMARY KEY,
      companies_json TEXT,
      merged_into TEXT
    );
    CREATE TABLE entity_legacy_map (
      entity_id TEXT NOT NULL,
      legacy_table TEXT NOT NULL,
      legacy_id TEXT NOT NULL
    );
    CREATE TABLE entity_summary (
      entity_id TEXT PRIMARY KEY,
      check_size_min_usd INTEGER,
      check_size_max_usd INTEGER,
      sectors_csv TEXT,
      stages_csv TEXT,
      geos_csv TEXT,
      primary_linkedin TEXT,
      primary_domain TEXT
    );
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      is_current INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      canonical TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );
  `);

  const prepare = (sql) => {
    const make = (boundArgs) => ({
      bind: (...args) => make(args),
      run: async () => {
        const info = db.prepare(sql).run(...boundArgs);
        return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
      },
      first: async () => db.prepare(sql).get(...boundArgs) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...boundArgs) }),
    });
    return make([]);
  };
  const DB = {
    prepare,
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
  return { DB, _db: db };
}

const countII = (env, where = "1=1", ...binds) =>
  env._db.prepare(`SELECT COUNT(*) AS n FROM investor_investments WHERE ${where}`).get(...binds).n;
const countCo = (env) => env._db.prepare("SELECT COUNT(*) AS n FROM companies").get().n;

test("resolveCompanyId dedupes by domain then slug, creates when missing", async () => {
  const env = makeEnv();
  const cache = new Map();
  const counters = { created: 0 };
  const a = await resolveCompanyId(env, "Acme, Inc.", "https://www.acme.com/about", cache, null, counters);
  // Same domain, different name string → same id, no new row.
  const b = await resolveCompanyId(env, "ACME Incorporated", "acme.com", cache, null, counters);
  assert.equal(a, b);
  // Same normalized name, no domain → matches via slug.
  const c = await resolveCompanyId(env, "the Acme Co", null, new Map(), null, counters);
  assert.equal(c, a);
  // A genuinely different company → new row.
  const d = await resolveCompanyId(env, "Globex", "globex.io", cache, null, counters);
  assert.notEqual(d, a);
  assert.equal(counters.created, 2);
  assert.equal(countCo(env), 2);
});

test("materializeInvestorPortfolio derives firm/partner/angel rows + is idempotent", async () => {
  const env = makeEnv();
  // Firm 1 with two current partners (one with a non-partner role → excluded)
  // and one ended partner (excluded).
  env._db.exec(`
    INSERT INTO firm_people (firm_id, lead_id, role, ended_at) VALUES
      (1, 'lead_p1', 'Partner', NULL),
      (1, 'lead_p2', 'General Partner', NULL),
      (1, 'lead_assist', 'Office Manager', NULL),
      (1, 'lead_old', 'Partner', '2020-01-01');
    INSERT INTO firm_portfolio (firm_id, company_name, company_domain, investment_year, stage, amount_usd, is_lead, source_url) VALUES
      (1, 'Stripe', 'stripe.com', 2018, 'series_b', 5000000, 1, 'https://f.com/p'),
      (1, 'Figma', 'figma.com', 2019, 'series_a', 2000000, 0, NULL);
    INSERT INTO leads (id, companies_json, merged_into) VALUES
      ('lead_angel', '[{"name":"Notion","domain":"notion.so","role":"angel investor","year":2016,"stage":"seed","amount_usd":50000},{"name":"SomeCoFounded","role":"founder"}]', NULL);
  `);
  // A manually-imported row that must survive re-derivation.
  env._db.exec(`INSERT INTO companies (name, slug, domain) VALUES ('Imported Co', 'imported co', 'imp.com');`);
  env._db.exec(`INSERT INTO investor_investments (investor_lead_id, company_id, source_provider, created_at) VALUES ('lead_p1', 1, 'manual', datetime('now'));`);

  const r1 = await materializeInvestorPortfolio(env);
  // Firm-level: 2 (one per portfolio company). Partner-level: 2 companies × 2 partners = 4.
  assert.equal(r1.firm_level, 2);
  assert.equal(r1.partner_level, 4);
  // Angel-level: only the investor entry, not the founder entry.
  assert.equal(r1.angel_level, 1);
  assert.equal(countII(env, "source_provider LIKE 'derive:%'"), 7);
  // Manual row preserved.
  assert.equal(countII(env, "source_provider = 'manual'"), 1);
  // Partner p1 sees both firm companies (derived) — angel lead unaffected here.
  assert.equal(countII(env, "investor_lead_id = 'lead_p1' AND source_provider LIKE 'derive:%'"), 2);
  // Non-partner staff + ended partner excluded.
  assert.equal(countII(env, "investor_lead_id = 'lead_assist'"), 0);
  assert.equal(countII(env, "investor_lead_id = 'lead_old'"), 0);

  // Idempotent: a second full run yields identical derived counts (no dup growth).
  const r2 = await materializeInvestorPortfolio(env);
  assert.deepEqual(
    { f: r2.firm_level, p: r2.partner_level, a: r2.angel_level },
    { f: 2, p: 4, a: 1 },
  );
  assert.equal(countII(env, "source_provider LIKE 'derive:%'"), 7);
  assert.equal(countII(env, "source_provider = 'manual'"), 1);
});

test("materializeInvestorPortfolio single-investor mode only rebuilds that investor", async () => {
  const env = makeEnv();
  env._db.exec(`
    INSERT INTO firm_people (firm_id, lead_id, role, ended_at) VALUES
      (1, 'lead_p1', 'Partner', NULL),
      (2, 'lead_p2', 'Partner', NULL);
    INSERT INTO firm_portfolio (firm_id, company_name, company_domain, investment_year) VALUES
      (1, 'Stripe', 'stripe.com', 2018),
      (2, 'Figma', 'figma.com', 2019);
  `);
  await materializeInvestorPortfolio(env); // full sweep
  const beforeP2 = countII(env, "investor_lead_id = 'lead_p2'");
  const beforeFirm = countII(env, "investor_lead_id IS NULL AND source_provider LIKE 'derive:%'");
  assert.equal(beforeP2, 1);
  assert.equal(beforeFirm, 2);

  // Re-run for lead_p1 only: p2's rows + firm-level rows untouched.
  const r = await materializeInvestorPortfolio(env, { investorLeadId: "lead_p1" });
  assert.equal(r.firm_level, 0); // single mode never emits firm-level rows
  assert.equal(countII(env, "investor_lead_id = 'lead_p1'"), 1);
  assert.equal(countII(env, "investor_lead_id = 'lead_p2'"), beforeP2);
  assert.equal(countII(env, "investor_lead_id IS NULL AND source_provider LIKE 'derive:%'"), beforeFirm);
});

test("non-investor executive roles do not inherit the firm portfolio", async () => {
  const env = makeEnv();
  // "Chief of Staff" / "Chief Operating Officer" must NOT fan out (they used to
  // match a broad `chief` token); only the genuine partner does.
  env._db.exec(`
    INSERT INTO firm_people (firm_id, lead_id, role, ended_at) VALUES
      (1, 'lead_partner', 'Managing Partner', NULL),
      (1, 'lead_cos', 'Chief of Staff', NULL),
      (1, 'lead_coo', 'Chief Operating Officer', NULL);
    INSERT INTO firm_portfolio (firm_id, company_name, company_domain, investment_year) VALUES
      (1, 'Stripe', 'stripe.com', 2018);
  `);
  await materializeInvestorPortfolio(env);
  assert.equal(countII(env, "investor_lead_id = 'lead_partner'"), 1);
  assert.equal(countII(env, "investor_lead_id = 'lead_cos'"), 0);
  assert.equal(countII(env, "investor_lead_id = 'lead_coo'"), 0);
});

test("row cap halts processing before creating orphan companies", async () => {
  const env = makeEnv();
  env._db.exec(`
    INSERT INTO firm_people (firm_id, lead_id, role, ended_at) VALUES (1, 'lead_p1', 'Partner', NULL);
    INSERT INTO firm_portfolio (firm_id, company_name, company_domain, investment_year) VALUES
      (1, 'Stripe', 'stripe.com', 2018),
      (1, 'Figma', 'figma.com', 2019),
      (1, 'Notion', 'notion.so', 2020);
  `);
  // Full sweep emits a firm-level row per company, so maxRows=1 stops after the
  // first company is resolved — the other two must never be created.
  const r = await materializeInvestorPortfolio(env, { maxRows: 1 });
  assert.equal(r.investments_written, 1);
  assert.equal(countCo(env), 1); // only the first company materialized, no orphans
});

test("loadInvestorEntityOverlay surfaces entity-store scalars", async () => {
  const env = makeEnv();
  env._db.exec(`
    INSERT INTO entity_legacy_map (entity_id, legacy_table, legacy_id) VALUES ('ent_1', 'leads', 'lead_x');
    INSERT INTO entity_summary (entity_id, check_size_min_usd, check_size_max_usd, sectors_csv, stages_csv, geos_csv, primary_linkedin, primary_domain)
      VALUES ('ent_1', 25000, 250000, 'fintech, ai', 'seed, series_a', 'us, eu', 'https://linkedin.com/in/x', 'x.com');
    INSERT INTO facts (entity_id, predicate, value_text, value_number, is_current) VALUES
      ('ent_1', 'bio', 'Seed investor.', NULL, 1),
      ('ent_1', 'thesis', 'Backs technical founders.', NULL, 1),
      ('ent_1', 'check_size_typical_usd', NULL, 100000, 1);
    INSERT INTO channels (entity_id, kind, canonical, is_primary) VALUES
      ('ent_1', 'twitter', 'https://twitter.com/x', 1),
      ('ent_1', 'github', 'https://github.com/x', 0);
  `);
  const o = await loadInvestorEntityOverlay(env, "lead_x");
  assert.equal(o.bio, "Seed investor.");
  assert.equal(o.thesis, "Backs technical founders.");
  assert.equal(o.check_size_min_usd, 25000);
  assert.equal(o.check_size_typical_usd, 100000);
  assert.deepEqual(o.sector_focus, ["fintech", "ai"]);
  assert.deepEqual(o.stage_focus, ["seed", "series_a"]);
  assert.equal(o.linkedin_url, "https://linkedin.com/in/x");
  assert.equal(o.twitter_url, "https://twitter.com/x");
  assert.equal(o.github_url, "https://github.com/x");

  // No mapping → empty overlay, no throw.
  const empty = await loadInvestorEntityOverlay(env, "missing");
  assert.equal(empty.bio, null);
  assert.deepEqual(empty.sector_focus, []);
});

test("coalesce helpers: legacy wins, overlay fills gaps", () => {
  assert.equal(coalesceStr("legacy", "overlay"), "legacy");
  assert.equal(coalesceStr("", "overlay"), "overlay");
  assert.equal(coalesceStr(null, "overlay"), "overlay");
  assert.equal(coalesceNum(0, 5), 0); // 0 is a real value, not empty
  assert.equal(coalesceNum(null, 5), 5);
  assert.deepEqual(coalesceArr(["a"], ["b"]), ["a"]);
  assert.deepEqual(coalesceArr([], ["b"]), ["b"]);
});
