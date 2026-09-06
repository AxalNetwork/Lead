// Merging two entities must not orphan the loser's data.
//
// mergeCore moved five tables — facts, channels, entity_tags, rel_edges and
// entity_legacy_map — and marked the secondary merged. The schema has 84 more
// that carry an entity reference, and none were touched. So merging two
// duplicate people left the loser's career history, board seats, identity
// handles, news mentions, roles, monitoring state, dossier synthesis and
// diligence findings pointing at a dead id. The merge reported success; the
// data simply stopped being reachable.
//
// This reads the real schema and asserts every entity-referencing column is
// either re-pointed by merge.ts or explicitly excluded with a reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MERGE_SRC = readFileSync(join(ROOT, "src/entities/merge.ts"), "utf8");

/** Column names that hold a u_entities id. */
const ENTITY_COLUMNS = [
  "entity_id", "src_entity_id", "dst_entity_id", "person_entity_id",
  "company_entity_id", "organization_entity_id", "investor_entity_id",
  "target_entity_id", "via_entity_id", "owner_entity_id", "issuer_entity_id",
  "holder_entity_id", "adviser_entity_id", "filer_entity_id",
  "subject_entity_id", "ref_entity_id", "related_entity_id",
];

/**
 * Tables merge deliberately does not re-point, each with the reason.
 * An entry here is a decision, not an oversight.
 */
const EXCLUDED = new Map(Object.entries({
  u_entities: "the merge target itself — status/merged_into_entity_id are set explicitly",
  entity_summary: "the secondary's row is DELETEd so a merged entity leaves search immediately",
  entity_roles: "unioned row-by-row before the batch so is_primary/confidence take the max",
  // These three declare entity_id as INTEGER: that is the legacy `entities`
  // id space, not a u_entities uuid. Writing one here would be wrong.
  dd_findings: "entity_id is INTEGER — the legacy entities id space, not u_entities",
  entity_risk_scores: "entity_id is INTEGER — legacy id space",
  dd_scan_runs: "entity_id is INTEGER — legacy id space",
}));

function schema() {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    try { db.exec(readFileSync(join(dir, f), "utf8")); } catch { /* covered by migrations_apply */ }
  }
  return db;
}

/** (table, column) pairs in the schema that reference a u_entities id. */
function entityReferences(db) {
  const out = [];
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    let cols;
    try { cols = db.prepare(`PRAGMA table_info("${r.name}")`).all(); } catch { continue; }
    for (const c of cols) {
      if (!ENTITY_COLUMNS.includes(c.name)) continue;
      // INTEGER entity_id is the legacy id space — a different table entirely.
      if (!/TEXT/i.test(c.type || "")) continue;
      out.push({ table: r.name, column: c.name });
    }
  }
  return out;
}

test("every table that references an entity is re-pointed on merge", () => {
  const db = schema();
  const refs = entityReferences(db);
  assert.ok(refs.length > 70, `only ${refs.length} entity references found — the scanner is broken`);

  const missing = refs.filter(({ table, column }) => {
    if (EXCLUDED.has(table)) return false;
    // The statements are written out literally, which is what makes this
    // greppable — and what keeps the repo's SQL gate happy.
    return !MERGE_SRC.includes(`${table} SET ${column} = ?`);
  });

  assert.deepEqual(
    missing.map((m) => `${m.table}.${m.column}`), [],
    "these columns still point at the merged-away entity after a merge, so the " +
    "data behind them becomes unreachable:\n  " +
    missing.map((m) => `${m.table}.${m.column}`).join("\n  ") +
    "\n\nAdd an UPDATE to repointEntityReferences, or add the table to " +
    "EXCLUDED with the reason it should not move.",
  );
});

test("the exclusion list has not gone stale", () => {
  const db = schema();
  const tables = new Set(entityReferences(db).map((r) => r.table));
  // u_entities/entity_summary/entity_roles are handled explicitly rather than
  // by the generated list, so they legitimately have entity references.
  const gone = [...EXCLUDED.keys()].filter((t) => {
    try { return db.prepare(`PRAGMA table_info("${t}")`).all().length === 0; }
    catch { return true; }
  });
  assert.deepEqual(gone, [], `EXCLUDED names tables that no longer exist: ${gone.join(", ")}`);
  void tables;
});

test("pointer columns are re-pointed but never deleted", () => {
  // Deleting on a pointer column would drop a person's career row because
  // their employer merged — worse than the bug being fixed.
  const POINTERS = ["organization_entity_id", "company_entity_id", "issuer_entity_id",
                    "adviser_entity_id", "investor_entity_id", "related_entity_id",
                    "ref_entity_id", "via_entity_id", "holder_entity_id"];
  for (const col of POINTERS) {
    assert.ok(
      !MERGE_SRC.includes(`DELETE FROM `) || !new RegExp(`DELETE FROM \\w+ WHERE ${col} = \\?`).test(MERGE_SRC),
      `merge deletes rows keyed on ${col}, a pointer column — it must only ever delete on entity_id`,
    );
  }
});

test("every generated statement uses OR IGNORE", () => {
  // 45 of these tables carry a unique constraint involving the entity column.
  // A plain UPDATE aborts the whole transaction on collision.
  const updates = [...MERGE_SRC.matchAll(/UPDATE (OR IGNORE )?(\w+) SET (\w+_entity_id|entity_id) = \?/g)];
  assert.ok(updates.length > 80, `expected the generated block, found ${updates.length} updates`);
  const plain = updates.filter((m) => !m[1]).map((m) => `${m[2]}.${m[3]}`);
  // The five original statements predate this and are covered by the
  // pre-merge dedup above them, so they are allowed to stay plain.
  const ORIGINAL = ["facts.entity_id", "channels.entity_id", "entity_tags.entity_id",
                    "rel_edges.src_entity_id", "rel_edges.dst_entity_id",
                    "entity_legacy_map.entity_id",
                    // not a re-point: this is the merge marker itself
                    "u_entities.merged_into_entity_id"];
  assert.deepEqual(plain.filter((p) => !ORIGINAL.includes(p)), [],
    "new re-point statements must use UPDATE OR IGNORE");
});
