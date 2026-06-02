// Task #12: tests for the first-class person/contact CSV import path.
//
// Boots an in-memory SQLite (node:sqlite, Node 22+) with the minimum
// schema the person upsert path touches (u_entities, entity_history,
// facts, channels) and exercises the three testable internals exported
// from src/imports/csv_import.ts:
//   * heuristicDetect  — header → entity_type classification
//   * rowToPersonCandidate — row projection + quality gate + raw capture
//   * upsertPerson — dedupe (email / linkedin / name+company) + facts
//
// Firm classification is asserted to stay "company" for firm headers so
// the existing firm import path is provably untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const ROOT = "../test-dist";
const { heuristicDetect, rowToPersonCandidate, upsertPerson } = await import(
  `${ROOT}/imports/csv_import.js`
);

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE u_entities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT,
      primary_url TEXT,
      primary_domain TEXT,
      primary_email_key TEXT,
      primary_linkedin_key TEXT,
      primary_twitter_handle TEXT,
      primary_github_handle TEXT,
      quality_score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      merged_into_entity_id TEXT,
      last_synced_vec_at TEXT,
      last_synced_search_at TEXT,
      last_summary_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE entity_history (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      source TEXT,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_json TEXT,
      value_entity_id TEXT,
      source_kind TEXT NOT NULL,
      source TEXT,
      evidence_url TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      valid_from TEXT,
      valid_to TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL,
      superseded_by_override INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hash)
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      canonical TEXT NOT NULL,
      display TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_dnc INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      confidence REAL NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Lazy compilation mirrors D1 semantics: prepare() never executes, so a
  // missing optional table (e.g. field_overrides probed by insertFact) only
  // surfaces at run/first/all time where the worker's .catch() handles it.
  const prepare = (sql) => {
    let pending = [];
    const obj = {
      bind: (...args) => { pending = args; return obj; },
      run: async () => { db.prepare(sql).run(...pending); return { success: true }; },
      first: async () => db.prepare(sql).get(...pending) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...pending) }),
    };
    return obj;
  };
  const env = {
    DB: { prepare },
    LEAD_QUEUE: { send: async () => {} },
    _db: db,
  };
  return env;
}

const count = (env, sql, ...binds) => env._db.prepare(sql).get(...binds).n;

// --- T001: detection ------------------------------------------------------
test("heuristicDetect classifies LinkedIn Connections headers as person", () => {
  const headers = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"];
  const d = heuristicDetect(headers);
  assert.equal(d.entity_type, "person");
  assert.equal(d.column_map["First Name"].predicate, "person.first_name");
  assert.equal(d.column_map["Email Address"].predicate, "person.email");
  assert.equal(d.column_map["URL"].predicate, "person.linkedin_url");
  assert.equal(d.column_map["Connected On"].predicate, "person.connected_on");
});

test("heuristicDetect classifies event attendee headers as person", () => {
  const headers = ["Name", "Email", "Company", "Title"];
  const d = heuristicDetect(headers);
  assert.equal(d.entity_type, "person");
  assert.equal(d.column_map["Name"].predicate, "person.full_name");
  assert.equal(d.column_map["Title"].predicate, "person.title");
});

test("heuristicDetect keeps firm headers as company (firm path untouched)", () => {
  const headers = ["Name", "Website", "Country", "AUM", "Thesis", "Stages"];
  const d = heuristicDetect(headers);
  assert.equal(d.entity_type, "company");
  assert.equal(d.column_map["Name"].predicate, "firm.name");
  assert.equal(d.column_map["Website"].predicate, "firm.website");
});

// --- T002: row projection + quality gate ----------------------------------
test("rowToPersonCandidate gate rejects rows with no usable identity", () => {
  const headers = ["First Name", "Last Name", "Email Address", "Custom Field"];
  const d = heuristicDetect(headers);
  assert.equal(rowToPersonCandidate(headers, ["", "", "", ""], d), null);
  assert.equal(rowToPersonCandidate(headers, [" ", " ", " ", "junk"], d), null);
});

test("rowToPersonCandidate retains unmapped columns as raw", () => {
  const headers = ["First Name", "Last Name", "Email Address", "Custom Field"];
  const d = heuristicDetect(headers);
  const c = rowToPersonCandidate(headers, ["Jane", "Smith", "jane@acme.com", "VIP"], d);
  assert.ok(c);
  assert.equal(c.display_name, "Jane Smith");
  assert.equal(c.email, "jane@acme.com");
  assert.equal(c.raw["custom_field"], "VIP");
});

// --- T003: upsert + dedupe ------------------------------------------------
test("upsertPerson creates then dedupes by email (enrich in place)", async () => {
  const env = makeEnv();
  const headers = ["Name", "Email", "Title"];
  const d = heuristicDetect(headers);
  const r1 = await upsertPerson(env, rowToPersonCandidate(headers, ["Jane Smith", "jane@acme.com", "CEO"], d), "csv_import:t.csv");
  assert.equal(r1.action, "created");
  // Same email, different name → must merge into the same entity.
  const r2 = await upsertPerson(env, rowToPersonCandidate(headers, ["Jane S.", "jane@acme.com", "Founder"], d), "csv_import:t.csv");
  assert.equal(r2.action, "updated");
  assert.equal(r1.entity_id, r2.entity_id);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM u_entities"), 1);
  // Title fact from the second import is present (enrichment in place).
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM facts WHERE predicate = 'title' AND value_text = 'Founder'"), 1);
});

test("upsertPerson dedupes by linkedin", async () => {
  const env = makeEnv();
  const headers = ["First Name", "Last Name", "URL"];
  const d = heuristicDetect(headers);
  const li = "https://www.linkedin.com/in/janesmith";
  const r1 = await upsertPerson(env, rowToPersonCandidate(headers, ["Jane", "Smith", li], d), "csv_import:t.csv");
  assert.equal(r1.action, "created");
  const r2 = await upsertPerson(env, rowToPersonCandidate(headers, ["Jane", "Smith", li], d), "csv_import:t.csv");
  assert.equal(r2.action, "updated");
  assert.equal(r1.entity_id, r2.entity_id);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM u_entities"), 1);
});

test("upsertPerson dedupes by name + company when no contact keys", async () => {
  const env = makeEnv();
  const headers = ["First Name", "Last Name", "Company"];
  const d = heuristicDetect(headers);
  assert.equal(d.entity_type, "person");
  const r1 = await upsertPerson(env, rowToPersonCandidate(headers, ["Jane", "Smith", "Acme Inc"], d), "csv_import:t.csv");
  assert.equal(r1.action, "created");
  const r2 = await upsertPerson(env, rowToPersonCandidate(headers, ["Jane", "Smith", "Acme Inc"], d), "csv_import:t.csv");
  assert.equal(r2.action, "updated");
  assert.equal(r1.entity_id, r2.entity_id);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM u_entities"), 1);
});

test("upsertPerson never attaches to a non-person entity sharing a channel", async () => {
  const env = makeEnv();
  // Seed an ORG entity that owns the same email channel.
  env._db.prepare(
    "INSERT INTO u_entities (id, kind, display_name, primary_email_key, status) VALUES (?, 'org', ?, ?, 'active')",
  ).run("org_1", "Acme Capital", "info@acme.com");
  env._db.prepare(
    "INSERT INTO channels (id, entity_id, kind, canonical) VALUES (?, 'org_1', 'email', ?)",
  ).run("ch_1", "info@acme.com");
  const headers = ["First Name", "Last Name", "Email Address"];
  const d = heuristicDetect(headers);
  const r = await upsertPerson(env, rowToPersonCandidate(headers, ["Info", "Desk", "info@acme.com"], d), "csv_import:t.csv");
  // Must mint a NEW person, not attach onto the org.
  assert.equal(r.action, "created");
  assert.notEqual(r.entity_id, "org_1");
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM u_entities WHERE kind = 'person'"), 1);
  // The org must remain untouched (no person facts mirrored onto it).
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM facts WHERE entity_id = 'org_1'"), 0);
});

test("upsertPerson backfills missing primary keys on an existing person", async () => {
  const env = makeEnv();
  // Seed an existing person with only an email key (no linkedin).
  env._db.prepare(
    "INSERT INTO u_entities (id, kind, display_name, primary_email_key, status) VALUES (?, 'person', ?, ?, 'active')",
  ).run("p_1", "Jane Smith", "jane@acme.com");
  const headers = ["First Name", "Last Name", "Email Address", "URL"];
  const d = heuristicDetect(headers);
  const li = "https://www.linkedin.com/in/janesmith";
  const r = await upsertPerson(env, rowToPersonCandidate(headers, ["Jane", "Smith", "jane@acme.com", li], d), "csv_import:t.csv");
  assert.equal(r.action, "updated");
  assert.equal(r.entity_id, "p_1");
  const row = env._db.prepare("SELECT primary_linkedin_key FROM u_entities WHERE id = 'p_1'").get();
  assert.ok(row.primary_linkedin_key, "linkedin key should be backfilled");
});

test("upsertPerson writes import.raw facts and channels", async () => {
  const env = makeEnv();
  const headers = ["First Name", "Last Name", "Email Address", "Custom Field"];
  const d = heuristicDetect(headers);
  assert.equal(d.entity_type, "person");
  const r = await upsertPerson(env, rowToPersonCandidate(headers, ["Jane", "Smith", "jane@acme.com", "VIP"], d), "csv_import:contacts.csv");
  assert.equal(r.action, "created");
  // Unmapped column retained as an import.raw.* fact with the right source.
  const raw = env._db.prepare("SELECT value_text, source, source_kind FROM facts WHERE predicate = 'import.raw.custom_field'").get();
  assert.equal(raw.value_text, "VIP");
  assert.equal(raw.source, "csv_import:contacts.csv");
  assert.equal(raw.source_kind, "import");
  // Email channel upserted.
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM channels WHERE kind = 'email' AND canonical = 'jane@acme.com'"), 1);
});
