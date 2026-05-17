// Task #4: DB-backed smoke test for the rich-profile EntityService helpers.
//
// Boots an in-memory SQLite (node:sqlite, Node 22+) with the minimum
// schema needed by `apps/worker/src/entities/profile.ts`:
//   * The two new migrations: 327_rich_person_profile.sql + 328_predicate_registry.sql
//   * A trimmed `facts` table matching migration 201 (UNIQUE(hash) is what
//     drives the mirrorFact dedupe path).
//
// Then for each of the 13 EntityService helpers it:
//   1. seeds one person and calls the helper with a deterministic input
//   2. asserts the corresponding structured row + facts row exist
//   3. re-runs the helper with identical input and asserts NO duplicates
//      in either the structured table or `facts`.
//
// This is the acceptance test the task spec calls out:
//   "smoke test seeds one person, calls every helper once, asserts each
//    structured row exists, asserts a corresponding facts row exists for
//    each, calls every helper a second time with identical inputs and
//    asserts no duplicates".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const ROOT = "../test-dist";

const { EntityService } = await import(`${ROOT}/entities/profile.js`);

// ---- env shim: adapts node:sqlite to the worker's env.DB.prepare(...) API.
//
// Tracks every executed statement so we can debug if an assertion fails
// (the natural-key ON CONFLICT() clauses use COALESCE expressions that
// node:sqlite parses identically to D1).
function makeEnv() {
  const db = new DatabaseSync(":memory:");
  // Schema: facts (subset of migration 201 — no trigger needed because
  // mirrorFact does its own insert-then-UPDATE-on-UNIQUE dance).
  db.exec(`
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
      supersedes_fact_id TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hash)
    );
  `);
  // Apply the two new migrations verbatim.
  db.exec(readFileSync(join(repoRoot, "migrations/327_rich_person_profile.sql"), "utf8"));
  db.exec(readFileSync(join(repoRoot, "migrations/328_predicate_registry.sql"), "utf8"));

  const prepare = (sql) => {
    let pending = [];
    const stmt = db.prepare(sql);
    // node:sqlite throws on `null` for INTEGER NOT NULL columns when it
    // can — but our `is_operator_asserted INTEGER NOT NULL DEFAULT 0`
    // accepts the literal 0 we bind anyway, so this is just a passthrough.
    const obj = {
      bind: (...args) => { pending = args; return obj; },
      run: async () => { stmt.run(...pending); return { success: true }; },
      first: async () => { return stmt.get(...pending) ?? null; },
      all: async () => { return { results: stmt.all(...pending) }; },
    };
    return obj;
  };
  // mirrorFact + helpers call DB.prepare(...) — single surface.
  const env = {
    DB: { prepare },
    ENTITY_LOCK: null,
    LEAD_QUEUE: { send: async () => {} },
    _db: db,
  };
  return env;
}

const ENTITY_ID = "person_test_001";
const SRC = "https://example.com/profile/test";

// Build one input per helper. Re-using the SAME inputs on the second
// call is the entire point: the natural-key UNIQUE on the structured
// table + the (entity, predicate, source_url) hash on `facts` must
// keep counts at exactly 1 per write.
const inputs = {
  setPersonIdentity: {
    entityId: ENTITY_ID, fullName: "Test Person", preferredName: "Test",
    pronouns: { subject: "they", object: "them", possessive: "their" },
    birthYear: 1985, nationality: "CA",
    languages: [{ code: "en", proficiency: "native" }, { code: "fr", proficiency: "fluent" }],
    timezone: "America/Toronto", locationCity: "Toronto", locationCountry: "CA",
    headshotUrl: "https://example.com/h.jpg", sourceUrl: SRC,
  },
  addCareerEntry: {
    entityId: ENTITY_ID, organizationName: "Acme Capital", roleTitle: "Partner",
    seniority: "partner", startedAt: "2020-01", isCurrent: true, sourceUrl: SRC,
  },
  addBoardSeat: {
    entityId: ENTITY_ID, organizationName: "OpenCo", role: "director",
    isIndependent: true, startedAt: "2022-03", sourceUrl: SRC,
  },
  addEducation: {
    entityId: ENTITY_ID, institution: "McGill University", degree: "BSc",
    field: "CS", startedYear: 2003, endedYear: 2007, sourceUrl: SRC,
  },
  addFamilyTie: {
    entityId: ENTITY_ID, relationType: "spouse", relatedName: "Jane Doe",
    isPublic: false, sourceUrl: SRC,
  },
  addPreference: {
    entityId: ENTITY_ID, preferenceKey: "coffee_order",
    valueText: "double espresso", sourceUrl: SRC,
  },
  addInterest: {
    entityId: ENTITY_ID, interestCategory: "topic", interestValue: "climate tech",
    sourceUrl: SRC,
  },
  addLifestyleSignal: {
    entityId: ENTITY_ID, signalKey: "runs",
    valueJson: { frequency: "weekly" }, sourceUrl: SRC,
  },
  addTravelPattern: {
    entityId: ENTITY_ID, patternKind: "frequent_city", place: "London",
    countryIso2: "GB", sourceUrl: SRC,
  },
  addConferenceAttendance: {
    entityId: ENTITY_ID, conferenceName: "Web Summit", year: 2024,
    role: "speaker", sourceUrl: SRC,
  },
  addGoal: {
    entityId: ENTITY_ID, goalKind: "fundraising",
    goalText: "Close Fund III by Q4", sourceUrl: SRC,
  },
  addConversationHook: {
    entityId: ENTITY_ID, hookKind: "shared_school",
    hookText: "Both went to McGill", sourceUrl: SRC,
  },
  addAppreciationSignal: {
    entityId: ENTITY_ID, signalKind: "cause_advocated",
    signalText: "Climate adaptation in coastal cities", sourceUrl: SRC,
  },
};

// Maps each helper to (structured table name, expected facts predicate).
// The dynamic-predicate helpers compose `person.<group>.<key>` exactly
// like profile.ts does.
const expectations = [
  ["setPersonIdentity",        "person_identity",        "person.identity"],
  ["addCareerEntry",           "career_history",         "person.career"],
  ["addBoardSeat",             "board_seats",            "person.board_seat"],
  ["addEducation",             "education_history",      "person.education"],
  ["addFamilyTie",             "family_ties",            "person.family_tie"],
  ["addPreference",            "person_preferences",     "person.preference.coffee_order"],
  ["addInterest",              "person_interests",       "person.interest.topic"],
  ["addLifestyleSignal",       "lifestyle_signals",      "person.lifestyle.runs"],
  ["addTravelPattern",         "travel_patterns",        "person.travel.frequent_city"],
  ["addConferenceAttendance",  "conference_attendance",  "person.conference"],
  ["addGoal",                  "person_goals",           "person.goal.fundraising"],
  ["addConversationHook",      "conversation_hooks",     "person.hook.shared_school"],
  ["addAppreciationSignal",    "appreciation_signals",   "person.appreciation.cause_advocated"],
];

function countRows(env, sql, ...args) {
  return env._db.prepare(sql).get(...args).c;
}

test("DB-backed smoke: every helper writes exactly one structured row + one facts row", async () => {
  const env = makeEnv();
  // First pass — populate.
  for (const [helper] of expectations) {
    await EntityService[helper](env, inputs[helper]);
  }
  // Assert one row per structured table + one fact per predicate.
  for (const [helper, table, predicate] of expectations) {
    const structRows = countRows(env, `SELECT COUNT(*) AS c FROM ${table} WHERE entity_id = ?`, ENTITY_ID);
    assert.equal(structRows, 1, `${helper}: expected 1 row in ${table}, got ${structRows}`);
    const factRows = countRows(env, `SELECT COUNT(*) AS c FROM facts WHERE entity_id = ? AND predicate = ?`, ENTITY_ID, predicate);
    assert.equal(factRows, 1, `${helper}: expected 1 fact row for ${predicate}, got ${factRows}`);
  }
  // Total facts written = 13 (one per helper).
  const total = countRows(env, `SELECT COUNT(*) AS c FROM facts WHERE entity_id = ?`, ENTITY_ID);
  assert.equal(total, expectations.length, `expected ${expectations.length} facts after first pass, got ${total}`);
});

test("DB-backed smoke: replaying every helper with identical input creates no duplicates", async () => {
  const env = makeEnv();
  // Pass 1
  for (const [helper] of expectations) {
    await EntityService[helper](env, inputs[helper]);
  }
  // Pass 2 — identical inputs.
  for (const [helper] of expectations) {
    await EntityService[helper](env, inputs[helper]);
  }
  for (const [helper, table, predicate] of expectations) {
    const structRows = countRows(env, `SELECT COUNT(*) AS c FROM ${table} WHERE entity_id = ?`, ENTITY_ID);
    assert.equal(structRows, 1, `${helper}: ${table} duplicated on replay (got ${structRows})`);
    const factRows = countRows(env, `SELECT COUNT(*) AS c FROM facts WHERE entity_id = ? AND predicate = ?`, ENTITY_ID, predicate);
    assert.equal(factRows, 1, `${helper}: fact ${predicate} duplicated on replay (got ${factRows})`);
  }
  const total = countRows(env, `SELECT COUNT(*) AS c FROM facts WHERE entity_id = ?`, ENTITY_ID);
  assert.equal(total, expectations.length, `expected ${expectations.length} facts after replay, got ${total}`);
});

test("DB-backed smoke: changing the value but keeping (entity, predicate, source_url) upserts in place", async () => {
  const env = makeEnv();
  // First write: coffee_order = "double espresso".
  await EntityService.addPreference(env, inputs.addPreference);
  // Second write: same entity + preferenceKey + sourceUrl, NEW value.
  await EntityService.addPreference(env, {
    ...inputs.addPreference,
    valueText: "flat white",
  });
  // Structured row: 1 (UNIQUE(entity_id, preference_key)), value updated.
  const row = env._db.prepare(
    `SELECT COUNT(*) AS c, MAX(value_text) AS v FROM person_preferences WHERE entity_id = ? AND preference_key = ?`,
  ).get(ENTITY_ID, "coffee_order");
  assert.equal(row.c, 1);
  assert.equal(row.v, "flat white");
  // Facts row: 1 — dedupe key is (entity, predicate, source_url), value-independent.
  const factRow = env._db.prepare(
    `SELECT COUNT(*) AS c, MAX(value_text) AS v FROM facts WHERE entity_id = ? AND predicate = ?`,
  ).get(ENTITY_ID, "person.preference.coffee_order");
  assert.equal(factRow.c, 1, "facts row must dedupe on (entity, predicate, source_url) regardless of value");
  assert.equal(factRow.v, "flat white", "facts row value must reflect latest write");
});

test("DB-backed smoke: same predicate from a DIFFERENT source_url DOES create a second facts row", async () => {
  const env = makeEnv();
  await EntityService.addInterest(env, inputs.addInterest);
  await EntityService.addInterest(env, { ...inputs.addInterest, sourceUrl: "https://other.example/profile" });
  const factRows = countRows(env, `SELECT COUNT(*) AS c FROM facts WHERE entity_id = ? AND predicate = ?`, ENTITY_ID, "person.interest.topic");
  assert.equal(factRows, 2, "two distinct source_urls must yield two facts rows (multi-source corroboration)");
});

test("DB-backed smoke: nullable-key components do not break ON CONFLICT idempotency", async () => {
  const env = makeEnv();
  // Career entry with NO organization_entity_id and NO started_at —
  // both nullable, both inside the natural key. Replay must still upsert.
  const partial = {
    entityId: ENTITY_ID, organizationName: "Stealth Co",
    roleTitle: "Advisor", sourceUrl: SRC,
  };
  await EntityService.addCareerEntry(env, partial);
  await EntityService.addCareerEntry(env, partial);
  const rows = countRows(env, `SELECT COUNT(*) AS c FROM career_history WHERE entity_id = ? AND organization_name = ?`, ENTITY_ID, "Stealth Co");
  assert.equal(rows, 1, "career_history must dedupe even when organization_entity_id and started_at are NULL");
});
