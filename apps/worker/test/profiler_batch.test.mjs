// The person → career_history → relationship-signal path, end to end.
//
// Four consecutive joints in this path were each independently broken, and
// every one of them failed by returning nothing rather than by erroring:
//
//   1. Nothing scheduled `runProfiler`. It ran only when an operator hit
//      POST /api/profilers/:entity_id/run, so the structured person
//      tables filled one hand-clicked person at a time.
//   2. `careerProfiler` read `organization_name` / `organization_entity_id`,
//      but SEC EDGAR — the only free live source of person.career facts —
//      writes `employer` / `employer_entity_id`.
//   3. Those SEC facts carried no `evidence_url`, and `careerProfiler`
//      drops any career fact without one.
//   4. `signalSameFirmOrSchool` read predicate `person.career_entry` (a
//      verification-claim predicate, never a facts row) and JSON paths
//      `$.firm_entity_id` / `$.school_name` that no writer emits;
//      `signalBoardOverlap` read `$.company_entity_id` / `$.start_date` /
//      `$.end_date` against a writer that emits `organization_entity_id` /
//      `started_at` / `ended_at`.
//
// The signal tests deliberately seed through the real `entities/profile.ts`
// writers rather than hand-rolling fact JSON, so the test cannot drift away
// from the payload the production path actually produces — which is the
// exact failure being pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const { careerProfiler } = await import("../test-dist/services/profilers/enrichers/career.js");
const { signalSameFirmOrSchool, signalBoardOverlap } = await import(
  "../test-dist/services/edgeQuality/signals.js"
);
const { addCareerEntry, addBoardSeat, addEducation } = await import(
  "../test-dist/entities/profile.js"
);
const { pickStalestProfilerTargets, runStalestProfilerBatch } = await import(
  "../test-dist/services/profilers/batch.js"
);

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, predicate TEXT NOT NULL,
      value_text TEXT, value_number REAL, value_json TEXT, value_entity_id TEXT,
      source_kind TEXT NOT NULL, source TEXT, evidence_url TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      valid_from TEXT, valid_to TEXT, supersedes_fact_id TEXT,
      is_current INTEGER NOT NULL DEFAULT 1, hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hash)
    );
    CREATE TABLE u_entities (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT,
      primary_url TEXT, primary_domain TEXT, primary_email_key TEXT,
      primary_linkedin_key TEXT, primary_twitter_handle TEXT,
      primary_github_handle TEXT, quality_score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', merged_into_entity_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE rel_edges (
      id TEXT PRIMARY KEY, src_entity_id TEXT NOT NULL, dst_entity_id TEXT NOT NULL,
      kind TEXT NOT NULL, strength REAL NOT NULL DEFAULT 1.0, valid_from TEXT,
      valid_to TEXT, evidence_url TEXT, backing_fact_ids_json TEXT, source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE conference_attendees (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, event_id TEXT NOT NULL,
      role TEXT, event_date TEXT
    );
    CREATE TABLE summary_rebuild_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL,
      enqueued_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(readFileSync(join(repoRoot, "migrations/327_rich_person_profile.sql"), "utf8"));
  db.exec(readFileSync(join(repoRoot, "migrations/328_predicate_registry.sql"), "utf8"));
  db.exec(readFileSync(join(repoRoot, "migrations/329_individual_profiler.sql"), "utf8"));

  // D1's prepare() is lazy — it does not compile the statement, so a query
  // naming a missing table rejects at run/first/all where callers catch it.
  // node:sqlite's prepare() throws immediately, which would make this shim
  // stricter than production and turn a caught degradation into a failure.
  const prepare = (sql) => {
    let pending = [];
    const exec = (fn) => async () => fn(db.prepare(sql));
    const mk = () => ({
      run:   exec((st) => { st.run(...pending); return { success: true }; }),
      first: exec((st) => st.get(...pending) ?? null),
      all:   exec((st) => ({ results: st.all(...pending) })),
    });
    return { bind: (...args) => { pending = args; return mk(); }, ...mk() };
  };

  const kv = new Map();
  const SESSIONS = {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
  };
  return {
    DB: { prepare }, SESSIONS, SCRAPE_CACHE: SESSIONS,
    ENTITY_LOCK: null, LEAD_QUEUE: { send: async () => {} },
    _db: db, _kv: kv,
  };
}

function person(env, id, name) {
  env._db.prepare(`INSERT INTO u_entities (id, kind, display_name) VALUES (?, 'person', ?)`)
    .run(id, name);
}

function rawFact(env, entityId, predicate, valueJson, evidenceUrl) {
  env._db.prepare(
    `INSERT INTO facts (id, entity_id, predicate, value_json, source_kind, source,
                        evidence_url, confidence, observed_at, is_current, hash)
     VALUES (?, ?, ?, ?, 'scrape', 'edgar', ?, 0.85, datetime('now'), 1, ?)`,
  ).run(
    crypto.randomUUID(), entityId, predicate,
    valueJson ? JSON.stringify(valueJson) : null,
    evidenceUrl ?? null,
    `seed:${entityId}:${predicate}:${Math.random()}`,
  );
}

// =========================================================================
// careerProfiler ← the SEC EDGAR payload shape
// =========================================================================

test("careerProfiler reads the SEC EDGAR career payload", async () => {
  const env = makeEnv();
  person(env, "p1", "Dana Reyes");
  // Exactly what services/secEdgar/persist.ts writes for a Form D
  // related person, filing URL included.
  rawFact(env, "p1", "person.career", {
    employer: "Northwind Capital LLC",
    employer_entity_id: "org-northwind",
    title: "Managing Member",
    source: "sec_form_d",
  }, "https://www.sec.gov/Archives/edgar/data/1/000-index.htm");

  const r = await careerProfiler.run(env, "p1", {});
  assert.equal(r.writes.length, 1, "the SEC-shaped fact must produce a career write");
  const w = r.writes[0];
  assert.equal(w.kind, "career");
  assert.equal(w.input.organizationName, "Northwind Capital LLC");
  assert.equal(
    w.input.organizationEntityId, "org-northwind",
    "employer_entity_id must survive — colleague_of needs a resolved org id, not a name string",
  );
  assert.equal(w.input.roleTitle, "Managing Member");
});

test("the profile.ts payload shape still works", async () => {
  const env = makeEnv();
  person(env, "p1", "Dana Reyes");
  rawFact(env, "p1", "person.career", {
    organization_name: "Acme Capital",
    organization_entity_id: "org-acme",
    role_title: "Partner",
  }, "https://acme.example/team");
  const r = await careerProfiler.run(env, "p1", {});
  assert.equal(r.writes.length, 1);
  assert.equal(r.writes[0].input.organizationName, "Acme Capital");
  assert.equal(r.writes[0].input.organizationEntityId, "org-acme");
});

test("a career fact with no evidence URL is still dropped", async () => {
  // Provenance is not optional: addCareerEntry uses sourceUrl as the
  // mirrored fact's `source`, so a blank one collapses every career row
  // for that person into a single superseding fact.
  const env = makeEnv();
  person(env, "p1", "Dana Reyes");
  rawFact(env, "p1", "person.career", { employer: "Northwind Capital LLC" }, null);
  const r = await careerProfiler.run(env, "p1", {});
  assert.equal(r.writes.length, 0);
});

// =========================================================================
// edge-quality signals ← the payloads entities/profile.ts actually writes
// =========================================================================

test("signalSameFirmOrSchool fires for two people at the same firm", async () => {
  const env = makeEnv();
  person(env, "a", "Person A");
  person(env, "b", "Person B");
  for (const id of ["a", "b"]) {
    await addCareerEntry(env, {
      entityId: id, organizationName: "Northwind Capital",
      organizationEntityId: "org-northwind", roleTitle: "Partner",
      startedAt: "2019-01", isCurrent: true,
      sourceUrl: `https://example.com/${id}/career`, confidence: 0.9,
    });
  }
  const sig = await signalSameFirmOrSchool(env, { src_entity_id: "a", dst_entity_id: "b" });
  assert.ok(sig, "two people at the same org must produce a same_firm_or_school signal");
  assert.ok(sig.value > 0);
});

test("signalSameFirmOrSchool fires for two alumni of the same school", async () => {
  const env = makeEnv();
  person(env, "a", "Person A");
  person(env, "b", "Person B");
  for (const id of ["a", "b"]) {
    await addEducation(env, {
      entityId: id, institution: "MIT", degree: "BSc", field: "EECS",
      startedYear: 2008, endedYear: 2012,
      sourceUrl: `https://example.com/${id}/edu`, confidence: 0.8,
    });
  }
  const sig = await signalSameFirmOrSchool(env, { src_entity_id: "a", dst_entity_id: "b" });
  assert.ok(sig, "shared institution must produce a signal");
});

test("signalSameFirmOrSchool stays silent for unrelated people", async () => {
  const env = makeEnv();
  person(env, "a", "Person A");
  person(env, "b", "Person B");
  await addCareerEntry(env, {
    entityId: "a", organizationName: "Northwind Capital",
    organizationEntityId: "org-northwind", sourceUrl: "https://example.com/a", confidence: 0.9,
  });
  await addCareerEntry(env, {
    entityId: "b", organizationName: "Southgate Partners",
    organizationEntityId: "org-southgate", sourceUrl: "https://example.com/b", confidence: 0.9,
  });
  assert.equal(await signalSameFirmOrSchool(env, { src_entity_id: "a", dst_entity_id: "b" }), null);
});

test("two people with no org id do not count as sharing an employer", async () => {
  // organizationEntityId is nullable on both writers. A NULL = NULL join
  // would make every unresolved pair look like colleagues.
  const env = makeEnv();
  person(env, "a", "Person A");
  person(env, "b", "Person B");
  for (const id of ["a", "b"]) {
    await addCareerEntry(env, {
      entityId: id, organizationName: "Stealth Startup",
      organizationEntityId: null,
      sourceUrl: `https://example.com/${id}`, confidence: 0.5,
    });
  }
  assert.equal(await signalSameFirmOrSchool(env, { src_entity_id: "a", dst_entity_id: "b" }), null);
});

test("signalSameFirmOrSchool matches the SEC fact shape too", async () => {
  // SEC-sourced career facts land in `facts` directly, before any
  // profiler run promotes them — the signal must see those as well.
  const env = makeEnv();
  person(env, "a", "Person A");
  person(env, "b", "Person B");
  for (const id of ["a", "b"]) {
    rawFact(env, id, "person.career", {
      employer: "Northwind Capital LLC", employer_entity_id: "org-northwind",
    }, "https://www.sec.gov/x");
  }
  const sig = await signalSameFirmOrSchool(env, { src_entity_id: "a", dst_entity_id: "b" });
  assert.ok(sig, "employer_entity_id must be coalesced alongside organization_entity_id");
});

test("signalBoardOverlap fires for a shared board with overlapping terms", async () => {
  const env = makeEnv();
  person(env, "a", "Person A");
  person(env, "b", "Person B");
  for (const id of ["a", "b"]) {
    await addBoardSeat(env, {
      entityId: id, organizationName: "GreenCo",
      organizationEntityId: "org-greenco", role: "director",
      startedAt: "2020-01-01", endedAt: "2023-01-01",
      sourceUrl: `https://example.com/${id}/board`, confidence: 0.9,
    });
  }
  const sig = await signalBoardOverlap(env, { src_entity_id: "a", dst_entity_id: "b" });
  assert.ok(sig, "a shared board seat with overlapping dates must produce a signal");
  assert.ok(sig.value > 0);
});

test("signalBoardOverlap stays silent for different boards", async () => {
  const env = makeEnv();
  person(env, "a", "Person A");
  person(env, "b", "Person B");
  await addBoardSeat(env, {
    entityId: "a", organizationName: "GreenCo", organizationEntityId: "org-green",
    startedAt: "2020-01-01", sourceUrl: "https://example.com/a", confidence: 0.9,
  });
  await addBoardSeat(env, {
    entityId: "b", organizationName: "BlueCo", organizationEntityId: "org-blue",
    startedAt: "2020-01-01", sourceUrl: "https://example.com/b", confidence: 0.9,
  });
  assert.equal(await signalBoardOverlap(env, { src_entity_id: "a", dst_entity_id: "b" }), null);
});

// =========================================================================
// the nightly batch driver
// =========================================================================

function withWorkflow(env) {
  const created = [];
  env.WF_PROFILER_INDIVIDUAL = {
    create: async (opts) => { created.push(opts.params); return { id: `wf-${created.length}` }; },
  };
  return created;
}

test("picks only person entities that have facts to promote", async () => {
  const env = makeEnv();
  person(env, "has_facts", "Has Facts");
  person(env, "no_facts", "No Facts");
  env._db.prepare(`INSERT INTO u_entities (id, kind, display_name) VALUES ('an_org', 'org', 'Northwind')`).run();
  env._db.prepare(`INSERT INTO u_entities (id, kind, display_name, status) VALUES ('gone', 'person', 'Deleted', 'soft_deleted')`).run();
  rawFact(env, "has_facts", "person.career", { employer: "X" }, "https://x.example");
  rawFact(env, "gone", "person.career", { employer: "X" }, "https://x.example");
  rawFact(env, "an_org", "thesis", { v: 1 }, "https://x.example");

  assert.deepEqual(await pickStalestProfilerTargets(env, 50), ["has_facts"]);
});

test("never-profiled entities sort ahead of recently-profiled ones", async () => {
  const env = makeEnv();
  for (const id of ["fresh", "old", "never"]) {
    person(env, id, id);
    rawFact(env, id, "person.career", { employer: "X" }, `https://x.example/${id}`);
  }
  const run = (entityId, when, status = "succeeded") =>
    env._db.prepare(
      `INSERT INTO profiler_runs (id, entity_id, status, triggered_by, started_at)
       VALUES (?, ?, ?, 'test', datetime('now', ?))`,
    ).run(crypto.randomUUID(), entityId, status, when);
  run("fresh", "-1 day");
  run("old", "-40 days");

  const picked = await pickStalestProfilerTargets(env, 50);
  assert.deepEqual(picked, ["never", "old"], "fresh is inside the 7-day window and must be skipped");
});

test("a failed run does not count as profiled", async () => {
  const env = makeEnv();
  person(env, "p", "P");
  rawFact(env, "p", "person.career", { employer: "X" }, "https://x.example");
  env._db.prepare(
    `INSERT INTO profiler_runs (id, entity_id, status, triggered_by, started_at)
     VALUES (?, 'p', 'failed', 'test', datetime('now'))`,
  ).run(crypto.randomUUID());
  assert.deepEqual(await pickStalestProfilerTargets(env, 50), ["p"]);
});

test("dispatches one workflow per entity and records the run header", async () => {
  const env = makeEnv();
  const created = withWorkflow(env);
  for (const id of ["a", "b"]) {
    person(env, id, id);
    rawFact(env, id, "person.career", { employer: "X" }, `https://x.example/${id}`);
  }

  const r = await runStalestProfilerBatch(env, { limit: 10 });
  assert.equal(r.mode, "workflow");
  assert.equal(r.dispatched, 2);
  assert.equal(r.errors, 0);
  assert.equal(created.length, 2);
  assert.equal(created[0].triggeredBy, "cron:nightly");
  assert.equal(created[0].forceRefresh, false);

  const rows = env._db.prepare(
    `SELECT entity_id, status, triggered_by, workflow_run_id FROM profiler_runs ORDER BY entity_id`,
  ).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "queued");
  assert.equal(rows[0].triggered_by, "cron:nightly");
  assert.ok(rows[0].workflow_run_id, "the dispatched workflow id must land on the header row");
});

test("the 7-day KV limiter blocks a re-dispatch the SQL gate would allow", async () => {
  // A run dispatched last night that has not yet written its row would
  // otherwise be picked again tonight.
  const env = makeEnv();
  const created = withWorkflow(env);
  person(env, "a", "A");
  rawFact(env, "a", "person.career", { employer: "X" }, "https://x.example/a");

  const first = await runStalestProfilerBatch(env, { limit: 10 });
  assert.equal(first.dispatched, 1);

  // Drop the run header, leaving only the KV stamp.
  env._db.prepare(`DELETE FROM profiler_runs`).run();

  const second = await runStalestProfilerBatch(env, { limit: 10 });
  assert.equal(second.dispatched, 0);
  assert.equal(second.rate_limited, 1);
  assert.equal(created.length, 1, "no second workflow may be created");
});

test("a failed dispatch does not lock the entity out for a week", async () => {
  const env = makeEnv();
  person(env, "a", "A");
  rawFact(env, "a", "person.career", { employer: "X" }, "https://x.example/a");
  env.WF_PROFILER_INDIVIDUAL = { create: async () => { throw new Error("dispatch exploded"); } };

  const r = await runStalestProfilerBatch(env, { limit: 10 });
  assert.equal(r.dispatched, 0);
  assert.equal(r.errors, 1);
  assert.equal(
    await env.SESSIONS.get("profiler:lastrun:a"), null,
    "the rate-limit stamp must be cleared for a run that never started",
  );
});

test("a batch that starts past the AI neuron cap does no work", async () => {
  const env = makeEnv();
  const created = withWorkflow(env);
  person(env, "a", "A");
  rawFact(env, "a", "person.career", { employer: "X" }, "https://x.example/a");
  env.AI_DAILY_NEURONS_CAP = "1000";
  env._db.exec(`CREATE TABLE ai_cost_daily (day TEXT, purpose TEXT, calls INTEGER, neurons REAL, cost_usd REAL)`);
  env._db.prepare(`INSERT INTO ai_cost_daily VALUES (date('now'), 'profiler', 1, 5000, 0.1)`).run();

  const r = await runStalestProfilerBatch(env, { limit: 10 });
  assert.equal(r.dispatched, 0);
  assert.ok(r.budget_skip?.startsWith("neurons_cap_reached"));
  assert.equal(created.length, 0);
});

test("without a workflow binding the inline ceiling is far lower", async () => {
  const env = makeEnv();
  for (const id of ["a", "b", "c", "d", "e"]) {
    person(env, id, id);
    rawFact(env, id, "person.career", { employer: "X" }, `https://x.example/${id}`);
  }
  const r = await runStalestProfilerBatch(env, { limit: 25 });
  assert.equal(r.mode, "inline");
  assert.ok(r.scanned <= 3, `inline mode must not scan a cron-sized batch, scanned ${r.scanned}`);
});
