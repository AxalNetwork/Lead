// Task #6: smoke tests for /api/profile-comments/:entity_id and the
// new dossier-page support endpoints (/changelog, /sources). Uses the
// same node:sqlite shim pattern as profilers.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

function makeDB() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE profile_comments (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      author_email TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );
    CREATE INDEX idx_profile_comments_entity
      ON profile_comments(entity_id, created_at DESC)
      WHERE deleted_at IS NULL;

    CREATE TABLE facts (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, predicate TEXT NOT NULL,
      value_text TEXT, value_number REAL, value_json TEXT, value_entity_id TEXT,
      source_kind TEXT NOT NULL, source TEXT, evidence_url TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      hash TEXT NOT NULL UNIQUE
    );
  `);
  return db;
}

// Minimal D1-shaped wrapper around node:sqlite so we can exercise the
// SQL exactly as the Hono routes do.
function shim(db) {
  return {
    prepare(sql) {
      return {
        _binds: [],
        bind(...args) { this._binds = args; return this; },
        async run() {
          const stmt = db.prepare(sql);
          const r = stmt.run(...this._binds);
          return { meta: { changes: r.changes ?? 0, last_row_id: r.lastInsertRowid ?? 0 } };
        },
        async all() {
          const stmt = db.prepare(sql);
          const results = stmt.all(...this._binds);
          return { results };
        },
        async first() {
          const stmt = db.prepare(sql);
          return stmt.get(...this._binds) ?? null;
        },
      };
    },
  };
}

test("profile_comments: insert + list filters soft-deleted", async () => {
  const db = makeDB();
  const DB = shim(db);
  const entityId = "ent_1";
  await DB.prepare(`INSERT INTO profile_comments (id, entity_id, author_email, body) VALUES (?, ?, ?, ?)`)
    .bind("c1", entityId, "op@example.com", "first note").run();
  await DB.prepare(`INSERT INTO profile_comments (id, entity_id, author_email, body) VALUES (?, ?, ?, ?)`)
    .bind("c2", entityId, "op@example.com", "second note").run();
  await DB.prepare(`UPDATE profile_comments SET deleted_at = datetime('now') WHERE id = ?`)
    .bind("c1").run();
  const r = await DB.prepare(
    `SELECT id, author_email, body, created_at FROM profile_comments
      WHERE entity_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
  ).bind(entityId).all();
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].id, "c2");
});

test("profile_comments: scoped to entity_id", async () => {
  const db = makeDB();
  const DB = shim(db);
  await DB.prepare(`INSERT INTO profile_comments (id, entity_id, author_email, body) VALUES (?, ?, ?, ?)`)
    .bind("c1", "ent_a", "op@x", "A note").run();
  await DB.prepare(`INSERT INTO profile_comments (id, entity_id, author_email, body) VALUES (?, ?, ?, ?)`)
    .bind("c2", "ent_b", "op@x", "B note").run();
  const r = await DB.prepare(
    `SELECT id FROM profile_comments WHERE entity_id = ? AND deleted_at IS NULL`,
  ).bind("ent_a").all();
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].id, "c1");
});

test("changelog SQL: returns recent facts for entity, descending", async () => {
  const db = makeDB();
  const DB = shim(db);
  // 3 facts, observed times spaced.
  await DB.prepare(`INSERT INTO facts (id, entity_id, predicate, value_text, source_kind, observed_at, hash)
                    VALUES (?,?,?,?,?,?,?)`).bind("f1","e","person.identity.full_name","Alice","scrape","2026-01-01T00:00:00Z","h1").run();
  await DB.prepare(`INSERT INTO facts (id, entity_id, predicate, value_text, source_kind, observed_at, hash)
                    VALUES (?,?,?,?,?,?,?)`).bind("f2","e","person.identity.location_city","Berlin","ai","2026-02-01T00:00:00Z","h2").run();
  await DB.prepare(`INSERT INTO facts (id, entity_id, predicate, value_text, source_kind, observed_at, hash)
                    VALUES (?,?,?,?,?,?,?)`).bind("f3","other","person.identity.full_name","Bob","scrape","2026-03-01T00:00:00Z","h3").run();
  const r = await DB.prepare(
    `SELECT id, predicate, source_kind, observed_at FROM facts WHERE entity_id = ?
     ORDER BY observed_at DESC LIMIT ?`,
  ).bind("e", 10).all();
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].id, "f2");
  assert.equal(r.results[1].id, "f1");
});

test("sources SQL: distinct (source_kind, source) with counts", async () => {
  const db = makeDB();
  const DB = shim(db);
  for (const [i, src] of [["s1", "scrape", "linkedin.com"], ["s2", "scrape", "linkedin.com"],
                          ["s3", "ai", "synth"], ["s4", "scrape", "twitter.com"]].entries()) {
    await DB.prepare(`INSERT INTO facts (id, entity_id, predicate, source_kind, source, observed_at, hash)
                      VALUES (?,?,?,?,?,?,?)`).bind(src[0], "e", "person.identity.full_name", src[1], src[2], "2026-01-0" + (i + 1) + "T00:00:00Z", "h" + src[0]).run();
  }
  const r = await DB.prepare(
    `SELECT source_kind, COALESCE(source, '(unspecified)') AS source, COUNT(*) AS n,
            MAX(observed_at) AS last_seen
       FROM facts WHERE entity_id = ?
       GROUP BY source_kind, source ORDER BY n DESC, last_seen DESC LIMIT 30`,
  ).bind("e").all();
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].source, "linkedin.com");
  assert.equal(r.results[0].n, 2);
});
