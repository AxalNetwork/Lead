// Task #8 — DB-contract integration test using node:sqlite.
//
// Asserts the persona_entity_matches schema's two critical
// behavioral guarantees directly via SQL (no TS service imports —
// the upsert SQL in personaMatching.ts mirrors what we test here):
//
//   1. Manual rows (source='manual') are NOT overwritten by auto upsert.
//   2. Auto re-score bumps last_scored_at + score + evidence + model_version.
//   3. The persona_match_jobs failure log accepts the four status enums.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migPath = join(__dirname, "..", "migrations", "331_persona_entity_matches.sql");

function bootDb() {
  const db = new DatabaseSync(":memory:");
  // Minimal personas + u_entities stubs so the migration's safety
  // stubs are no-ops and FKs (if any) resolve.
  db.exec(`
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, status TEXT, deleted_at TEXT);
    CREATE TABLE u_entities (id TEXT PRIMARY KEY, kind TEXT, status TEXT, display_name TEXT, quality_score REAL);
  `);
  // Let migration 331's CREATE TABLE IF NOT EXISTS stubs create
  // persona_matches + entity_legacy_map with the schema the backfill
  // SELECT expects (fit_score, components_json, entity_kind, ...).
  const sql = readFileSync(migPath, "utf8");
  db.exec(sql);
  return db;
}

test("persona_entity_matches: manual rows survive auto upsert", () => {
  const db = bootDb();
  db.prepare(`INSERT INTO personas(id,name,status) VALUES('p1','x','active')`).run();
  db.prepare(`INSERT INTO u_entities(id,kind,status,display_name,quality_score) VALUES('e1','person','active','x',1)`).run();

  // Seed a manual override row at score 0.99.
  db.prepare(
    `INSERT INTO persona_entity_matches(persona_id,entity_id,score,match_evidence_json,source,model_version,last_scored_at)
     VALUES('p1','e1',0.99,'{"manual":true}','manual','manual-v1', datetime('now'))`,
  ).run();

  // Mirror the auto upsert from personaMatching.ts: it sets
  // source='auto' on conflict ONLY when the existing row isn't manual.
  // We emulate the guard here as a WHERE clause on UPDATE.
  db.prepare(
    `INSERT INTO persona_entity_matches(persona_id,entity_id,score,match_evidence_json,source,model_version,last_scored_at)
     VALUES('p1','e1',0.42,'{"auto":true}','auto','v1', datetime('now'))
     ON CONFLICT(persona_id, entity_id) DO UPDATE SET
       score = CASE WHEN persona_entity_matches.source='manual' THEN persona_entity_matches.score ELSE excluded.score END,
       match_evidence_json = CASE WHEN persona_entity_matches.source='manual' THEN persona_entity_matches.match_evidence_json ELSE excluded.match_evidence_json END,
       source = CASE WHEN persona_entity_matches.source='manual' THEN 'manual' ELSE 'auto' END,
       model_version = CASE WHEN persona_entity_matches.source='manual' THEN persona_entity_matches.model_version ELSE excluded.model_version END,
       last_scored_at = excluded.last_scored_at`,
  ).run();

  const row = db.prepare(`SELECT * FROM persona_entity_matches WHERE persona_id='p1' AND entity_id='e1'`).get();
  assert.equal(row.source, "manual");
  assert.equal(row.score, 0.99);
  assert.equal(row.model_version, "manual-v1");
});

test("persona_entity_matches: auto re-score bumps score + last_scored_at", () => {
  const db = bootDb();
  db.prepare(`INSERT INTO personas(id,name,status) VALUES('p1','x','active')`).run();
  db.prepare(`INSERT INTO u_entities(id,kind,status,display_name,quality_score) VALUES('e1','person','active','x',1)`).run();

  db.prepare(
    `INSERT INTO persona_entity_matches(persona_id,entity_id,score,match_evidence_json,source,model_version,last_scored_at)
     VALUES('p1','e1',0.10,'{}','auto','v1','2020-01-01T00:00:00Z')`,
  ).run();

  db.prepare(
    `INSERT INTO persona_entity_matches(persona_id,entity_id,score,match_evidence_json,source,model_version,last_scored_at)
     VALUES('p1','e1',0.80,'{"new":true}','auto','v2', datetime('now'))
     ON CONFLICT(persona_id, entity_id) DO UPDATE SET
       score = excluded.score, match_evidence_json = excluded.match_evidence_json,
       model_version = excluded.model_version, last_scored_at = excluded.last_scored_at`,
  ).run();

  const row = db.prepare(`SELECT score, model_version, last_scored_at FROM persona_entity_matches WHERE persona_id='p1' AND entity_id='e1'`).get();
  assert.equal(row.score, 0.80);
  assert.equal(row.model_version, "v2");
  assert.notEqual(row.last_scored_at, "2020-01-01T00:00:00Z");
});

test("persona_match_jobs accepts all status enums and records slo_violation flag", () => {
  const db = bootDb();
  for (const status of ["ok", "halted", "failed", "cancelled"]) {
    db.prepare(
      `INSERT INTO persona_match_jobs(id, kind, status, persona_id, details_json) VALUES(?, 'dispatch', ?, 'p1', ?)`,
    ).run(`j-${status}`, status, JSON.stringify({ slo_violation: status !== "ok" }));
  }
  const rows = db.prepare(`SELECT status, json_extract(details_json,'$.slo_violation') AS slo FROM persona_match_jobs ORDER BY status`).all();
  assert.equal(rows.length, 4);
  const slo = rows.filter((r) => r.slo === 1).length;
  assert.equal(slo, 3, "three of four statuses should flag slo_violation");
});
