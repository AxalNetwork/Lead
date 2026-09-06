// Soft-delete must be reversible. It was not.
//
// `softDeleteEntity` flips u_entities.status and then runs
// `DELETE FROM entity_roles WHERE entity_id = ?`. `restoreEntity` flipped
// the status back and stopped there — nothing put the roles back. So a
// restored entity came back with no roles at all and stayed invisible on
// every role-filtered surface: the investor lists, the persona matchers,
// the founder screens. The console reported "restored" and the operator
// had no way to see that it had not worked.
//
// That matters more than a normal bug because the whole cleanup strategy
// is quarantine-then-review: soft-delete the suspected garbage, restore the
// false positives. A restore that silently drops the roles turns every
// false positive into a permanent loss, which is exactly what soft-delete
// exists to avoid.
//
// These run the real functions against the real migrations rather than a
// re-implementation of their SQL, because the defect was in what the code
// did, not in what the schema allowed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { softDeleteEntity, restoreEntity } =
  await import("../test-dist/entities/garbage.js");

// D1-faithful shim: bind() returns a NEW statement (real D1 statements are
// immutable), run/first/all are async, and `all()` wraps rows in `results`.
function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
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
  return { env: { DB: { prepare } }, db };
}

function seed(db, id, roles) {
  db.prepare("INSERT INTO u_entities (id, kind, display_name) VALUES (?, 'person', ?)").run(id, id);
  for (const r of roles) {
    db.prepare(
      "INSERT INTO entity_roles (entity_id, role, is_primary, source, confidence) VALUES (?, ?, ?, ?, ?)",
    ).run(id, r.role, r.is_primary ?? 0, r.source ?? "seed", r.confidence ?? 1.0);
  }
}

// node:sqlite hands back null-prototype rows; deepEqual compares prototypes.
const rolesOf = (db, id) =>
  db.prepare(
    "SELECT role, is_primary, source, confidence FROM entity_roles WHERE entity_id = ? ORDER BY role",
  ).all(id).map((r) => ({ role: r.role, is_primary: r.is_primary, source: r.source, confidence: r.confidence }));

const statusOf = (db, id) =>
  db.prepare("SELECT status FROM u_entities WHERE id = ?").get(id).status;

test("the migrations this test relies on actually applied", () => {
  const { db } = makeEnv();
  for (const t of ["u_entities", "entity_roles", "data_quality_log"]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    assert.ok(row, `${t} missing — the rest of this file would pass vacuously`);
  }
});

test("restore puts back every role soft-delete removed", async () => {
  const { env, db } = makeEnv();
  seed(db, "ent_a", [
    { role: "investor", is_primary: 1, source: "sec_edgar", confidence: 0.9 },
    { role: "board_member", is_primary: 0, source: "wikidata", confidence: 0.6 },
  ]);

  await softDeleteEntity(env, "ent_a", ["listicle_page_title"], "cron_sweep", null);
  assert.equal(statusOf(db, "ent_a"), "soft_deleted");
  assert.deepEqual(rolesOf(db, "ent_a"), [], "soft-delete is expected to clear the roles");

  await restoreEntity(env, "ent_a", "ops@example.com");
  assert.equal(statusOf(db, "ent_a"), "active");
  assert.deepEqual(rolesOf(db, "ent_a"), [
    { role: "board_member", is_primary: 0, source: "wikidata", confidence: 0.6 },
    { role: "investor", is_primary: 1, source: "sec_edgar", confidence: 0.9 },
  ], "a restored entity with no roles is invisible on every role-filtered surface");
});

test("the restore audit row records how many roles came back", async () => {
  const { env, db } = makeEnv();
  seed(db, "ent_b", [{ role: "founder" }, { role: "operator" }]);
  await softDeleteEntity(env, "ent_b", ["r"], "operator", "ops@example.com");
  await restoreEntity(env, "ent_b", "ops@example.com");

  const row = db.prepare(
    "SELECT reasons_json FROM data_quality_log WHERE entity_id = ? AND issue = 'restored'",
  ).get("ent_b");
  assert.deepEqual(JSON.parse(row.reasons_json), ["roles_restored:2"],
    "without a count in the audit trail an operator cannot tell a full restore from a partial one");
});

test("a second soft-delete does not replay the first one's roles", async () => {
  // The stale-park case. Park only-when-non-empty would leave the FIRST
  // park as the newest row here, and this restore would resurrect roles the
  // entity no longer had.
  const { env, db } = makeEnv();
  seed(db, "ent_c", [{ role: "investor" }]);

  await softDeleteEntity(env, "ent_c", ["r1"], "cron_sweep", null);
  await restoreEntity(env, "ent_c", "ops@example.com");
  assert.equal(rolesOf(db, "ent_c").length, 1);

  db.prepare("DELETE FROM entity_roles WHERE entity_id = ?").run("ent_c");
  await softDeleteEntity(env, "ent_c", ["r2"], "cron_sweep", null);
  await restoreEntity(env, "ent_c", "ops@example.com");

  assert.deepEqual(rolesOf(db, "ent_c"), [],
    "restore replayed a park from an earlier soft-delete");
});

test("restoring an entity that never had roles is a clean no-op", async () => {
  const { env, db } = makeEnv();
  seed(db, "ent_d", []);
  await softDeleteEntity(env, "ent_d", ["r"], "cron_sweep", null);
  await restoreEntity(env, "ent_d", "ops@example.com");
  assert.equal(statusOf(db, "ent_d"), "active");
  assert.deepEqual(rolesOf(db, "ent_d"), []);
});

test("replay is idempotent — restoring twice does not duplicate or downgrade roles", async () => {
  // entity_roles is UNIQUE(entity_id, role); a plain INSERT would throw on
  // the second pass and abort the replay mid-way.
  const { env, db } = makeEnv();
  seed(db, "ent_e", [{ role: "investor", is_primary: 1, source: "sec_edgar", confidence: 0.9 }]);
  await softDeleteEntity(env, "ent_e", ["r"], "cron_sweep", null);
  await restoreEntity(env, "ent_e", "ops@example.com");
  await restoreEntity(env, "ent_e", "ops@example.com");
  assert.deepEqual(rolesOf(db, "ent_e"), [
    { role: "investor", is_primary: 1, source: "sec_edgar", confidence: 0.9 },
  ]);
});
