// Every SQL statement the worker runs must be valid against the real schema.
//
// This does not pattern-match. It applies all 111 migrations into an
// in-memory SQLite and calls prepare() on every static SQL literal in
// apps/worker/src — which is exactly the validation D1 performs, so it
// catches missing TABLES and missing COLUMNS with no false positives.
//
// It matters because nothing else catches them. Almost every one of these
// queries sits inside a catch that returns 0, [] or null, so a permanent
// failure is indistinguishable from "healthy but empty". That is how 54 of
// them accumulated across 714 files — including seven of the eight
// edge-quality signals that feed Power Nodes, the error-log readers on the
// ops and health consoles (the instruments you would use to notice), the
// frontier depth probes, and a diligence query with no catch at all that
// simply threw.
//
// 23 are fixed. The rest are listed below with the reason each remains, so
// the number can only go down: anything not on that list fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Statements that still reference something the schema does not define,
 * keyed by "<file> :: <sqlite error>".
 *
 * These are NOT acceptable-by-default. Each is a feature that cannot work
 * until the migration lands or the caller stops pretending the data exists.
 * They are enumerated so a NEW one is a test failure rather than another
 * silent zero.
 */
const KNOWN_BAD = new Map(Object.entries({
  // --- unbuilt features: no migration creates the table, and nothing
  // --- populates it, so these reads can only ever return nothing.
  "src/services/verification/references.ts :: no such table: publication_authors":
    "no publication ingestion exists; the co_authored_with edge extractor is dead with it",
  "src/services/verification/runner.ts :: no such table: publication_authors": "as above",
  "src/services/verification/references.ts :: no such table: accelerator_batches":
    "no accelerator ingestion exists",
  "src/services/verification/runner.ts :: no such table: accelerator_batches": "as above",
  "src/services/verification/verifiers/directorship.ts :: no such table: sec_director_filings":
    "SEC director-filing extraction was never built",
  "src/services/verification/verifiers/priorStartup.ts :: no such table: opencorporates_status":
    "OpenCorporates status caching was never built",
  "src/services/secEdgar/discovery.ts :: no such table: sec_fts_queue":
    "the SEC full-text-search queue was never created, so that discovery path is inert",
  "src/services/diligence/checks/ip.ts :: no such table: uspto_patents":
    "no USPTO ingestion; the IP diligence check always scores 0",
  "src/services/edgeQuality/signals.ts :: no such table: social_interactions":
    "no Twitter interaction ingestion — tos-flags.json blocks it — so signalTwitterReplyRate can never fire",
  "src/services/edgeQuality/signals.ts :: no such table: linkedin_endorsements":
    "no LinkedIn ingestion — tos-flags.json blocks it — so signalLinkedInEndorsements can never fire",
  "src/agent/tools.ts :: no such table: dd_scans":
    "scan history table never created; the real ones are dd_scan_runs + entity_risk_scores",
  "src/monitoring/summary.ts :: no such table: dd_entity_state":
    "per-entity diligence state never created",
  "src/routes/profile_slices_for_health.ts :: no such table: predictions":
    "no predictions table; routes/profile.ts was repointed at intro_paths, this reader was not",
  "src/services/mlOps/calibration.ts :: no such table: predictions": "as above",
  "src/routes/profilers.ts :: no such table: pii_audit_log":
    "the real audit table is pii_access_log, keyed by lead_id with no action column — a different model, not a rename",
  "src/profile/influence.ts :: no such table: unified_links":
    "legacy lead<->entity link table, superseded by entity_legacy_map",
  "src/services/diligence/checks/corporate.ts :: no such table: cap_table_rows":
    "reshaped into cap_table_holders + cap_table_snapshots; this reader still wants the flat shape",

  // --- model mismatches: the data exists but under a different shape, so
  // --- fixing these is a design decision rather than a rename.
  "src/projects/pitch.ts :: no such column: from_kind":
    "walks relationships as kind:id composites; the table stores numeric legacy ids in src/dst",
  "src/monitoring/summary.ts :: no such column: investor_entity_id":
    "investor_investments keys on investor_lead_id (legacy), not on a u_entities id",
  "src/agent/tools.ts :: no such column: pm.intent_score":
    "persona_matches scores fit only; there is no intent model",
  "src/routes/influence.ts :: no such column: u.role_default":
    "u_entities has no default-role column; roles live in entity_roles",
  "src/routes/admin.ts :: no such column: l.role":
    "leads stores persona_role, not role",
  "src/routes/dossiers.ts :: no such column: post_money_usd":
    "deal_events records valuation_usd + valuation_type instead",
  "src/routes/predictions.ts :: no such column: f.name":
    "funds has no name column",
  "src/routes/profile_slices_for_health.ts :: no such column: axis":
    "entity_profile_axes stores each axis as its own column, not as rows",
  "src/routes/ops_system_health.ts :: no such column: updated_at":
    "compute_nodes has no updated_at",
  "src/services/diligence/checks/market.ts :: no such column: rel_kind":
    "rel_edges names the column kind",
  "src/services/verification/verifiers/employment.ts :: no such column: snapshot_url":
    "firm_team_snapshots has no snapshot_url",
  "src/routes/bulk.ts :: no such column: id":
    "builds a statement against a caller-chosen table; not statically resolvable",
  "src/routes/bulk.ts :: no such table: …":
    "a documentation snippet in a template literal, not an executed statement",
}));

function realSchema() {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  let applied = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    try { db.exec(readFileSync(join(dir, f), "utf8")); applied++; } catch { /* trigger bodies */ }
  }
  return { db, applied };
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules" && e !== "__tests__") walk(p, out); }
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Every static (non-interpolated) SQL statement in the worker. */
function staticStatements() {
  const out = [];
  for (const file of walk(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const lit of src.matchAll(/`([^`]*)`/g)) {
      const sql = lit[1];
      if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql.trim())) continue;
      if (/\$\{/.test(sql)) continue;   // interpolated — cannot be checked statically
      out.push({ file: relative(ROOT, file), sql });
    }
  }
  return out;
}

test("the migrations build a real schema", () => {
  const { db, applied } = realSchema();
  assert.ok(applied > 100, `only ${applied} migrations applied — the harness is broken`);
  const n = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
  assert.ok(n > 200, `only ${n} tables created — the harness is broken`);
});

test("every static SQL statement is valid against the real schema", () => {
  const { db } = realSchema();
  const statements = staticStatements();
  assert.ok(statements.length > 1000, `only ${statements.length} statements found — the scanner is broken`);

  const bad = [];
  for (const { file, sql } of statements) {
    try { db.prepare(sql); } catch (e) {
      const msg = (e.message || "").replace(/ - should this be.*/, "");
      if (!/no such column|no such table/i.test(msg)) continue;  // syntax-only: a fragment, not our business
      const key = `${file} :: ${msg}`;
      if (KNOWN_BAD.has(key)) continue;
      bad.push(`${key}\n      ${sql.replace(/\s+/g, " ").trim().slice(0, 150)}`);
    }
  }
  assert.deepEqual(
    [...new Set(bad)], [],
    "these statements reference something the schema does not define. Every one of " +
    "them fails silently at runtime:\n  " + [...new Set(bad)].join("\n  ") +
    "\n\nFix the query, add the migration, or — if the feature is genuinely " +
    "unbuilt — add it to KNOWN_BAD with the reason.",
  );
});

test("the known-bad list has not gone stale", () => {
  // An entry that now prepares cleanly means it was fixed. Remove it, so the
  // list keeps meaning what it says.
  const { db } = realSchema();
  const live = new Set();
  for (const { file, sql } of staticStatements()) {
    try { db.prepare(sql); } catch (e) {
      const msg = (e.message || "").replace(/ - should this be.*/, "");
      if (/no such column|no such table/i.test(msg)) live.add(`${file} :: ${msg}`);
    }
  }
  const stale = [...KNOWN_BAD.keys()].filter((k) => !live.has(k));
  assert.deepEqual(stale, [], `KNOWN_BAD entries that now pass — delete them:\n  ${stale.join("\n  ")}`);
});

test("the tables and columns the renames repointed to really exist", () => {
  const { db } = realSchema();
  const ok = (sql) => { db.prepare(sql); };
  // One assertion per rename made while fixing this, so a later edit cannot
  // quietly reintroduce the old name.
  ok("SELECT id, title, url, published_at FROM news_items LIMIT 1");
  ok("SELECT news_item_id, entity_id, detected_at FROM news_entity_mentions LIMIT 1");
  ok("SELECT entity_id, conference_name, year, role FROM conference_attendance LIMIT 1");
  ok("SELECT owner_entity_id, issuer_entity_id, form_type, transaction_date FROM sec_insider_trades LIMIT 1");
  ok("SELECT kind, canonical, is_dnc FROM channels LIMIT 1");
  ok("SELECT occurred_at, code, step FROM error_log LIMIT 1");
  ok("SELECT scheduled_at, attempts FROM crawl_frontier LIMIT 1");
  ok("SELECT discovered_at, status FROM smart_frontier LIMIT 1");
  ok("SELECT trust_score FROM entity_risk_scores LIMIT 1");
  ok("SELECT announcement_date, source_url FROM deal_events LIMIT 1");
  ok("SELECT verified FROM leads LIMIT 1");
  ok("SELECT body_excerpt FROM news_items LIMIT 1");
  ok("SELECT created_at FROM identity_handles LIMIT 1");
  ok("SELECT kind, value FROM dnc_list LIMIT 1");
});
