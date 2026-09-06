// Guard against queries naming tables and columns that do not exist.
//
// Six of these were live at once, and every one of them failed silently:
// the ops console wraps each counter in a try/catch that returns 0, and the
// profile envelope marks a slice "missing" and moves on. So a broken query
// is indistinguishable from healthy-and-empty, which is the worst possible
// failure mode for the surfaces you use to decide whether the data pipeline
// is working.
//
//   ops_quality.ts   data_quality_log.created_at   -> detected_at
//   ops_quality.ts   field_overrides.status        -> no such column
//   ops_quality.ts   cross_ref_candidates          -> no such table
//   admin.ts         entity_summary.updated_at     -> rebuilt_at
//   profile.ts       predictions                   -> no such table
//
// This reads the migrations as the source of truth and checks the SQL in the
// files that were wrong. It is deliberately narrow: table existence is
// unambiguous, and the specific columns that drifted are asserted by name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function migrationSql() {
  const dir = join(root, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

const SQL = migrationSql();

/** Tables and views the schema actually defines. */
function definedRelations() {
  const names = new Set();
  const re = /CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(SQL))) names.add(m[1].toLowerCase());
  return names;
}

/** Columns declared anywhere inside one CREATE TABLE block. */
function columnsOf(table) {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`,
    "i",
  );
  const block = SQL.match(re);
  const cols = new Set();
  if (block) {
    for (const line of block[1].split("\n")) {
      const m = line.trim().match(/^[`"[]?([a-z_][a-z0-9_]*)/i);
      if (m) cols.add(m[1].toLowerCase());
    }
  }
  // ALTER TABLE ... ADD COLUMN x
  const alter = new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+[\`"\\[]?([a-z_][a-z0-9_]*)`, "gi");
  let a;
  while ((a = alter.exec(SQL))) cols.add(a[1].toLowerCase());
  return cols;
}

const RELATIONS = definedRelations();

/**
 * The SQL a source file actually executes: backtick template literals that
 * contain a statement keyword. Checking raw source instead matches prose in
 * comments — including a comment explaining the very bug being asserted.
 */
function sqlOf(relPath) {
  const src = readFileSync(join(root, relPath), "utf8");
  return [...src.matchAll(/`([^`]*)`/g)]
    .map((x) => x[1])
    .filter((t) => /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(t))
    .join("\n");
}

test("the migrations parse into a non-trivial schema", () => {
  // Sanity: if the parser breaks, every other test here passes vacuously.
  assert.ok(RELATIONS.size > 100, `expected >100 relations, parsed ${RELATIONS.size}`);
  for (const t of ["facts", "u_entities", "leads", "firms", "companies", "accounts"]) {
    assert.ok(RELATIONS.has(t), `core table ${t} not parsed out of the migrations`);
  }
});

// ---- table existence ---------------------------------------------------

const SCANNED = [
  "src/routes/ops_quality.ts",
  "src/routes/admin.ts",
  "src/routes/profile.ts",
];

// Relations created at runtime, aliased in CTEs, or provided by the platform.
const NOT_IN_MIGRATIONS = new Set(["sqlite_master", "pragma_table_info", "json_each"]);

test("every table these routes query exists in the migrations", () => {
  const bad = [];
  for (const rel of SCANNED) {
    const sqlLiterals = sqlOf(rel);
    // Names appearing after FROM or JOIN, skipping subqueries "FROM (".
    const re = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b/gi;
    let m;
    const cteNames = new Set(
      [...sqlLiterals.matchAll(/\bWITH\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)].map((x) => x[1].toLowerCase()),
    );
    while ((m = re.exec(sqlLiterals))) {
      const name = m[1].toLowerCase();
      if (RELATIONS.has(name) || NOT_IN_MIGRATIONS.has(name) || cteNames.has(name)) continue;
      bad.push(`${rel}: FROM/JOIN ${name}`);
    }
  }
  assert.deepEqual(
    [...new Set(bad)],
    [],
    `these queries name relations that no migration creates, and every one of ` +
      `them fails silently at runtime:\n  ${[...new Set(bad)].join("\n  ")}`,
  );
});

// ---- the specific columns that drifted ---------------------------------

test("data_quality_log timestamps on detected_at, not created_at", () => {
  const cols = columnsOf("data_quality_log");
  assert.ok(cols.has("detected_at"));
  assert.ok(!cols.has("created_at"), "if created_at was added, revisit ops_quality.ts");
  const sql = sqlOf("src/routes/ops_quality.ts");
  assert.ok(!/data_quality_log[\s\S]{0,400}?\bq?\.?created_at\s*>=/.test(sql),
    "ops_quality still filters data_quality_log on created_at");
});

test("field_overrides has locked/unlock_after and no status column", () => {
  const cols = columnsOf("field_overrides");
  assert.ok(cols.has("locked"));
  assert.ok(cols.has("unlock_after"));
  assert.ok(!cols.has("status"), "if status was added, revisit ops_quality.ts");
  const sql = sqlOf("src/routes/ops_quality.ts");
  assert.ok(!/FROM field_overrides[\s\S]{0,200}?status\s*=/.test(sql),
    "ops_quality still filters field_overrides on a status column that does not exist");
});

test("entity_summary timestamps on rebuilt_at, not updated_at", () => {
  const cols = columnsOf("entity_summary");
  assert.ok(cols.has("rebuilt_at"));
  assert.ok(!cols.has("updated_at"), "if updated_at was added, revisit admin.ts");
  const sql = sqlOf("src/routes/admin.ts");
  assert.ok(!/entity_summary[\s\S]{0,300}?s\.updated_at/.test(sql),
    "admin.ts still reads entity_summary.updated_at");
});

test("intro_paths carries the columns the profile envelope reads", () => {
  const cols = columnsOf("intro_paths");
  for (const c of ["target_entity_id", "predicted_conversion_pct", "ranking_mode", "created_at"]) {
    assert.ok(cols.has(c), `intro_paths.${c} missing`);
  }
});
