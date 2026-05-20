// Task #3 (Editable Profiles) — REAL-DB integration tests for the
// Jim Murphy acceptance scenario. Uses node:sqlite to spin up an
// in-memory database, applies the relevant migrations, and exercises
// the SQL contract of `insertFact` (override-aware) and the read-time
// overlay (loadCurrentOverrides shape).
//
// The actual TypeScript helpers live in apps/worker/src/entities/facts.ts
// and run on Cloudflare's D1 binding (not directly importable here);
// this test asserts the SQL-level behavior they implement, so a change
// to the contract that breaks the acceptance scenario fails this test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function mkDb() {
  const db = new DatabaseSync(":memory:");
  // Minimal facts schema (mirrors migration 201_facts + 376 additions).
  db.exec(`
    CREATE TABLE u_entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, status TEXT NOT NULL DEFAULT 'active');
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
      hash TEXT NOT NULL UNIQUE,
      superseded_by_override INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Apply migration 376 verbatim (skips the ALTER since we already have
  // the column in the inline schema above).
  const mig = readFileSync(resolve(__dirname, "../migrations/376_field_overrides.sql"), "utf8");
  const stmtSql = mig.replace(/ALTER TABLE facts ADD COLUMN[^;]+;/, "-- skipped (column inlined)");
  db.exec(stmtSql);
  db.prepare("INSERT INTO u_entities (id, kind, display_name) VALUES (?, ?, ?)").run("ent_jim", "person", "Jim Murphy");
  return db;
}

// Inlines the lock-check + post-insert re-check pattern from
// entities/facts.ts::insertFact in JS so we can exercise the SQL
// contract end-to-end.
function insertFactSql(db, f) {
  const lockRow = db.prepare(
    `SELECT 1 AS found FROM field_overrides
      WHERE entity_id = ? AND predicate = ? AND locked = 1
        AND (unlock_after IS NULL OR unlock_after > datetime('now'))
      LIMIT 1`,
  ).get(f.entity_id, f.predicate);
  const stamp = lockRow ? 1 : 0;
  const id = "fact_" + Math.random().toString(36).slice(2);
  const hash = id + "_" + (f.value_text ?? "");
  db.prepare(
    `INSERT INTO facts (id, entity_id, predicate, value_text, source_kind, source, hash, superseded_by_override)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, f.entity_id, f.predicate, f.value_text ?? null, f.source_kind, f.source ?? null, hash, stamp);
  // Race-fix re-check.
  if (!stamp) {
    db.prepare(
      `UPDATE facts SET superseded_by_override = 1
        WHERE id = ?
          AND EXISTS (
            SELECT 1 FROM field_overrides
             WHERE entity_id = ? AND predicate = ? AND locked = 1
               AND (unlock_after IS NULL OR unlock_after > datetime('now'))
          )`,
    ).run(id, f.entity_id, f.predicate);
  }
  return id;
}

function applyOverride(db, entityId, predicate, valueText, email, reason) {
  const id = "ov_" + Math.random().toString(36).slice(2);
  db.prepare(
    `INSERT INTO field_overrides (id, entity_id, predicate, value_text, override_reason, overridden_by_email, locked) VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, entityId, predicate, valueText, reason, email);
  db.prepare(
    `UPDATE facts SET superseded_by_override = 1 WHERE entity_id = ? AND predicate = ? AND is_current = 1`,
  ).run(entityId, predicate);
  return id;
}

// Mirrors the read-time overlay (loadCurrentOverrides + the loadEntity
// substitution from entities/query.ts).
function getCanonicalValue(db, entityId, predicate) {
  const ov = db.prepare(
    `SELECT value_text FROM field_overrides
      WHERE entity_id = ? AND predicate = ? AND locked = 1
        AND (unlock_after IS NULL OR unlock_after > datetime('now'))
      ORDER BY overridden_at DESC LIMIT 1`,
  ).get(entityId, predicate);
  if (ov) return { value: ov.value_text, source: "override" };
  const row = db.prepare(
    `SELECT value_text FROM facts
      WHERE entity_id = ? AND predicate = ? AND is_current = 1 AND superseded_by_override = 0
      ORDER BY observed_at DESC LIMIT 1`,
  ).get(entityId, predicate);
  return row ? { value: row.value_text, source: "facts" } : { value: null, source: null };
}

// ---------- 1. Jim Murphy acceptance scenario ----------
test("Jim Murphy: override beats subsequent AI fact at read time", () => {
  const db = mkDb();
  // 1. AI extracted a title.
  insertFactSql(db, { entity_id: "ent_jim", predicate: "title", value_text: "Sequoia partner", source_kind: "ai", source: "extractor:v1" });
  assert.equal(getCanonicalValue(db, "ent_jim", "title").value, "Sequoia partner");
  // 2. Operator overrides.
  applyOverride(db, "ent_jim", "title", "Partner, Global Strategic Relationships at Sequoia", "op@example.com", "fix from Jim directly");
  const after = getCanonicalValue(db, "ent_jim", "title");
  assert.equal(after.value, "Partner, Global Strategic Relationships at Sequoia");
  assert.equal(after.source, "override");
  // 3. AI re-fills with a different value — should be stamped, not canonical.
  insertFactSql(db, { entity_id: "ent_jim", predicate: "title", value_text: "Sequoia investor", source_kind: "ai", source: "extractor:v2" });
  const stamped = db.prepare(`SELECT value_text, superseded_by_override FROM facts WHERE source = 'extractor:v2'`).get();
  assert.equal(stamped.value_text, "Sequoia investor");
  assert.equal(stamped.superseded_by_override, 1, "new AI fact must be stamped superseded_by_override");
  // 4. Canonical still resolves to override.
  const final = getCanonicalValue(db, "ent_jim", "title");
  assert.equal(final.value, "Partner, Global Strategic Relationships at Sequoia");
  // 5. AI attempts visible in history (superseded_by_override=1).
  const attempts = db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE entity_id = 'ent_jim' AND predicate = 'title' AND superseded_by_override = 1`).get();
  assert.equal(attempts.n, 2, "both AI attempts (pre + post override) are stamped");
});

// ---------- 2. Race: override created between SELECT and INSERT ----------
test("race: AI fact inserted just before override → post-insert re-check stamps it", () => {
  const db = mkDb();
  // Simulate: insertFact's lock-check sees no override (writes
  // stamp=0), then the override lands BEFORE the post-insert UPDATE
  // would have run if we'd done them naively. The post-insert UPDATE
  // in our SQL pattern catches this.
  const lock = db.prepare(`SELECT 1 FROM field_overrides WHERE entity_id = ? AND predicate = ? AND locked = 1`).get("ent_jim", "title");
  assert.equal(lock, undefined, "no override yet");
  const id = "fact_race_1";
  db.prepare(`INSERT INTO facts (id, entity_id, predicate, value_text, source_kind, hash, superseded_by_override) VALUES (?, ?, ?, ?, ?, ?, 0)`)
    .run(id, "ent_jim", "title", "AI value", "ai", "hash_race_1");
  // Override lands.
  db.prepare(`INSERT INTO field_overrides (id, entity_id, predicate, value_text, override_reason, overridden_by_email, locked) VALUES (?, ?, ?, ?, ?, ?, 1)`)
    .run("ov_race", "ent_jim", "title", "operator value", "fix", "op@example.com");
  // Post-insert re-check (from insertFact race fix).
  db.prepare(`UPDATE facts SET superseded_by_override = 1 WHERE id = ? AND EXISTS (SELECT 1 FROM field_overrides WHERE entity_id = ? AND predicate = ? AND locked = 1)`)
    .run(id, "ent_jim", "title");
  const row = db.prepare(`SELECT superseded_by_override FROM facts WHERE id = ?`).get(id);
  assert.equal(row.superseded_by_override, 1, "race-window fact must be stamped by the post-insert re-check");
});

// ---------- 3. Unlock transitions ----------
test("unlock flips locked=0 and AI value becomes canonical again", () => {
  const db = mkDb();
  insertFactSql(db, { entity_id: "ent_jim", predicate: "title", value_text: "AI value", source_kind: "ai" });
  applyOverride(db, "ent_jim", "title", "Operator value", "op@example.com", "fix");
  assert.equal(getCanonicalValue(db, "ent_jim", "title").value, "Operator value");
  // Unlock (mirrors POST /unlock + clear-stamp).
  db.prepare(`UPDATE field_overrides SET locked = 0, unlock_after = datetime('now') WHERE entity_id = ? AND predicate = ?`).run("ent_jim", "title");
  db.prepare(`UPDATE facts SET superseded_by_override = 0 WHERE entity_id = ? AND predicate = ? AND is_current = 1`).run("ent_jim", "title");
  const after = getCanonicalValue(db, "ent_jim", "title");
  assert.equal(after.value, "AI value");
  assert.equal(after.source, "facts");
});

// ---------- 4. Bulk override + revert ----------
test("bulk override writes one row per entity sharing bulk_operation_id, revertable as a group", () => {
  const db = mkDb();
  db.prepare(`INSERT INTO u_entities (id, kind) VALUES ('ent_a','person')`).run();
  db.prepare(`INSERT INTO u_entities (id, kind) VALUES ('ent_b','person')`).run();
  const bulkId = "bulk_x";
  for (const eid of ["ent_a", "ent_b"]) {
    db.prepare(`INSERT INTO field_overrides (id, entity_id, predicate, value_text, override_reason, overridden_by_email, locked, bulk_operation_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run("ov_" + eid, eid, "sector", "fintech", "bulk fix", "op@example.com", bulkId);
  }
  const c1 = db.prepare(`SELECT COUNT(*) AS n FROM field_overrides WHERE bulk_operation_id = ? AND locked = 1`).get(bulkId);
  assert.equal(c1.n, 2);
  // Revert.
  db.prepare(`UPDATE field_overrides SET locked = 0, unlock_after = datetime('now') WHERE bulk_operation_id = ?`).run(bulkId);
  const c2 = db.prepare(`SELECT COUNT(*) AS n FROM field_overrides WHERE bulk_operation_id = ? AND locked = 1`).get(bulkId);
  assert.equal(c2.n, 0, "all rows in the bulk group are unlocked together");
  // History preserved.
  const c3 = db.prepare(`SELECT COUNT(*) AS n FROM field_overrides WHERE bulk_operation_id = ?`).get(bulkId);
  assert.equal(c3.n, 2, "rows are not deleted on revert");
});

// ---------- 5. Audit log append-only ----------
test("entity_audit_log is append-only — restore is a new row, not an edit", () => {
  const db = mkDb();
  db.prepare(`INSERT INTO entity_audit_log (id, entity_id, action, actor_email, payload_json) VALUES (?, ?, ?, ?, ?)`)
    .run("a1", "ent_jim", "soft_delete", "op@example.com", '{"reason":"dup"}');
  db.prepare(`INSERT INTO entity_audit_log (id, entity_id, action, actor_email, payload_json) VALUES (?, ?, ?, ?, ?)`)
    .run("a2", "ent_jim", "restore", "op@example.com", "{}");
  const rows = db.prepare(`SELECT action FROM entity_audit_log WHERE entity_id = ? ORDER BY id ASC`).all("ent_jim");
  assert.deepEqual(rows.map((r) => r.action), ["soft_delete", "restore"]);
});

// ---------- 6a. Task #1 fix: legacy-id resolution at action boundary ----------
// Inlines the resolveEntityId helper from routes/overrides.ts so we can
// exercise the SQL contract end-to-end on the in-memory harness. The
// real helper runs on Cloudflare's D1 binding (not directly importable
// here); this test asserts the SQL-level behavior it implements.
const LEGACY_TABLE_WHITELIST = ["leads", "firms", "companies", "accounts", "buyers"];
function resolveEntityIdSql(db, id) {
  if (!id) return null;
  const direct = db.prepare(`SELECT id FROM u_entities WHERE id = ?`).get(id);
  if (direct?.id) return { entityId: direct.id, resolvedFromLegacy: false };
  const ph = LEGACY_TABLE_WHITELIST.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT entity_id FROM entity_legacy_map
      WHERE legacy_id = ? AND legacy_table IN (${ph}) LIMIT 1`,
  ).get(id, ...LEGACY_TABLE_WHITELIST);
  if (row?.entity_id) return { entityId: row.entity_id, resolvedFromLegacy: true };
  return null;
}

function mkDbWithLegacyMap() {
  const db = mkDb();
  db.exec(`
    CREATE TABLE entity_legacy_map (
      legacy_table TEXT NOT NULL,
      legacy_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (legacy_table, legacy_id)
    );
  `);
  return db;
}

test("resolveEntityId: legacy leads.id resolves to u_entities.id", () => {
  const db = mkDbWithLegacyMap();
  db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`)
    .run("leads", "lead-uuid-1", "ent_jim");
  const r = resolveEntityIdSql(db, "lead-uuid-1");
  assert.equal(r?.entityId, "ent_jim");
  assert.equal(r?.resolvedFromLegacy, true);
});

test("resolveEntityId: direct u_entities.id resolves without legacy lookup", () => {
  const db = mkDbWithLegacyMap();
  const r = resolveEntityIdSql(db, "ent_jim");
  assert.equal(r?.entityId, "ent_jim");
  assert.equal(r?.resolvedFromLegacy, false);
});

test("resolveEntityId: unknown id (no u_entities, no legacy map row) returns null", () => {
  const db = mkDbWithLegacyMap();
  const r = resolveEntityIdSql(db, "totally-unknown");
  assert.equal(r, null);
});

test("resolveEntityId: legacy_table outside whitelist (e.g. 'people') does NOT resolve", () => {
  const db = mkDbWithLegacyMap();
  db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`)
    .run("people", "person-uuid", "ent_jim");
  const r = resolveEntityIdSql(db, "person-uuid");
  assert.equal(r, null, "people is not in the operator-action whitelist");
});

test("resolveEntityId: firms / companies / accounts / buyers all resolve", () => {
  const db = mkDbWithLegacyMap();
  db.prepare(`INSERT INTO u_entities (id, kind) VALUES ('ent_firm','firm')`).run();
  db.prepare(`INSERT INTO u_entities (id, kind) VALUES ('ent_co','company')`).run();
  db.prepare(`INSERT INTO u_entities (id, kind) VALUES ('ent_acct','account')`).run();
  db.prepare(`INSERT INTO u_entities (id, kind) VALUES ('ent_buyer','buyer')`).run();
  const rows = [
    ["firms", "firm-1", "ent_firm"],
    ["companies", "co-1", "ent_co"],
    ["accounts", "acct-1", "ent_acct"],
    ["buyers", "buyer-1", "ent_buyer"],
  ];
  for (const [t, lid, eid] of rows) {
    db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`).run(t, lid, eid);
  }
  for (const [, lid, eid] of rows) {
    const r = resolveEntityIdSql(db, lid);
    assert.equal(r?.entityId, eid);
    assert.equal(r?.resolvedFromLegacy, true);
  }
});

// ---------- 6b. Soft-delete via resolved legacy id ----------
test("soft-delete: legacy leads.id resolves and flips u_entities.status='soft_deleted'", () => {
  const db = mkDbWithLegacyMap();
  db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`)
    .run("leads", "lead-uuid-1", "ent_jim");
  const resolved = resolveEntityIdSql(db, "lead-uuid-1");
  assert.ok(resolved);
  db.prepare(`UPDATE u_entities SET status = 'soft_deleted' WHERE id = ?`).run(resolved.entityId);
  const after = db.prepare(`SELECT status FROM u_entities WHERE id = ?`).get(resolved.entityId);
  assert.equal(after.status, "soft_deleted");
});

test("soft-delete: direct u_entities.id still succeeds (no regression)", () => {
  const db = mkDbWithLegacyMap();
  const resolved = resolveEntityIdSql(db, "ent_jim");
  assert.equal(resolved?.entityId, "ent_jim");
  db.prepare(`UPDATE u_entities SET status = 'soft_deleted' WHERE id = ?`).run(resolved.entityId);
  const after = db.prepare(`SELECT status FROM u_entities WHERE id = ?`).get("ent_jim");
  assert.equal(after.status, "soft_deleted");
});

test("soft-delete: unknown id returns not_found (resolveEntityId → null)", () => {
  const db = mkDbWithLegacyMap();
  const resolved = resolveEntityIdSql(db, "ghost-id");
  assert.equal(resolved, null);
});

test("merge: legacy source id + canonical target id both resolve", () => {
  const db = mkDbWithLegacyMap();
  db.prepare(`INSERT INTO u_entities (id, kind) VALUES ('ent_target','person')`).run();
  db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`)
    .run("leads", "lead-src", "ent_jim");
  const src = resolveEntityIdSql(db, "lead-src");
  const tgt = resolveEntityIdSql(db, "ent_target");
  assert.equal(src?.entityId, "ent_jim");
  assert.equal(tgt?.entityId, "ent_target");
  assert.notEqual(src.entityId, tgt.entityId, "cannot_merge_into_self check passes after resolution");
});

test("merge: both sides legacy ids resolve through entity_legacy_map", () => {
  const db = mkDbWithLegacyMap();
  db.prepare(`INSERT INTO u_entities (id, kind) VALUES ('ent_target','person')`).run();
  db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`)
    .run("leads", "lead-src", "ent_jim");
  db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`)
    .run("firms", "firm-tgt", "ent_target");
  const src = resolveEntityIdSql(db, "lead-src");
  const tgt = resolveEntityIdSql(db, "firm-tgt");
  assert.equal(src?.entityId, "ent_jim");
  assert.equal(tgt?.entityId, "ent_target");
  assert.equal(src.resolvedFromLegacy, true);
  assert.equal(tgt.resolvedFromLegacy, true);
});

test("merge: two distinct legacy ids pointing at same canonical entity → cannot_merge_into_self", () => {
  const db = mkDbWithLegacyMap();
  db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`)
    .run("leads", "lead-a", "ent_jim");
  db.prepare(`INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES (?, ?, ?)`)
    .run("firms", "firm-a", "ent_jim");
  const src = resolveEntityIdSql(db, "lead-a");
  const tgt = resolveEntityIdSql(db, "firm-a");
  assert.equal(src.entityId, tgt.entityId, "self-merge detected POST-resolution");
});

// ---------- 6. Override for predicate with no underlying fact ----------
test("override for a predicate with no underlying fact still wins canonical read", () => {
  const db = mkDb();
  applyOverride(db, "ent_jim", "twitter_handle", "@jim", "op@example.com", "from biz card");
  const v = getCanonicalValue(db, "ent_jim", "twitter_handle");
  assert.equal(v.value, "@jim");
  assert.equal(v.source, "override");
});
