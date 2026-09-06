// Every table the worker queries must exist in the migrations.
//
// A query naming a table no migration creates does not crash this codebase —
// almost every one of them sits inside a catch that returns 0, [] or null, so
// a permanent failure is indistinguishable from "healthy but empty". That is
// how 23 of them accumulated unnoticed across 714 files, including four of the
// eight edge-quality signals that feed Power Nodes, the entire news path
// behind Conversation Hooks, and a UNION in the verification runner where two
// absent tables meant the discovery pass never returned a single entity.
//
// This is the guard, not the cleanup. The renames are fixed; what remains is
// listed below with the reason it remains. Anything NOT on that list fails
// here, so the count can only go down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Relations the migrations actually define. */
function definedRelations() {
  const dir = join(ROOT, "migrations");
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const names = new Set();
  const re = /CREATE\s+(?:VIRTUAL\s+|TEMP\s+|TEMPORARY\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) names.add(m[1].toLowerCase());
  return names;
}

/** Provided by SQLite itself, not by a migration. */
const BUILTIN = new Set([
  "sqlite_master", "sqlite_temp_master", "sqlite_sequence",
  "pragma_table_info", "pragma_index_list", "pragma_foreign_key_list",
  "json_each", "json_tree", "dual",
]);

/**
 * Tables queried by the worker that no migration creates.
 *
 * Every entry needs a reason. These are NOT acceptable-by-default: each is a
 * feature that cannot work until either the migration lands or the caller
 * stops pretending the data exists. They are listed so that a NEW one is a
 * test failure rather than another silent zero.
 */
const KNOWN_ABSENT = new Map(Object.entries({
  // --- CTE names this scanner cannot see, because the WITH clause arrives
  // --- through string interpolation. Not defects.
  wanted: "CTE built from an interpolated fragment in routes/influence.ts",
  inv_leads: "CTE built from an interpolated `baseCte` in routes/investors.ts",

  // --- Features that are simply unbuilt. The reads are guarded, so they
  // --- degrade to empty rather than erroring — which is precisely why nobody
  // --- noticed they were never going to return anything.
  predictions: "no predictions table exists; routes/profile.ts was repointed at intro_paths, these three readers were not",
  publication_authors: "nothing ingests publications, so the co_authored_with edge extractor is permanently dead",
  accelerator_batches: "no accelerator ingestion exists",
  dd_scans: "the diligence scan history table was never created",
  dd_entity_state: "diligence per-entity state was never created",
  uspto_patents: "no USPTO ingestion exists; the IP diligence check always scores 0",
  social_interactions: "no Twitter interaction ingestion (tos-flags.json blocks it); signalTwitterReplyRate can never fire",
  linkedin_endorsements: "no LinkedIn ingestion (tos-flags.json blocks it); signalLinkedInEndorsements can never fire",
  identity_posts: "no per-post social archive exists; the social_post monitoring trigger never fires",
  compliance_dnc: "the do-not-contact list has no table; privacy.ts treats every entity as contactable",
  sec_director_filings: "SEC director-filing extraction was never built",
  opencorporates_status: "OpenCorporates company-status caching was never built",
  sec_fts_queue: "the SEC full-text-search queue was never created",
  unified_links: "legacy lead<->entity link table, superseded by entity_legacy_map",
  entity_channels: "renamed to `channels`; this one reader in garbage.ts still says entity_channels",
  cap_table_rows: "renamed/reshaped to cap_table_holders + cap_table_snapshots; corporate.ts still reads the old shape",
  pii_audit_log: "privacy audit trail was never created; every write is wrapped in a catch",
}));

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules" && e !== "__tests__") walk(p, out); }
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Relation names a SQL literal introduces itself (CTEs, temp tables). */
function locallyDefined(sql) {
  const local = new Set();
  for (const m of sql.matchAll(/\bWITH\s+(?:RECURSIVE\s+)?([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s*\(/gi)) local.add(m[1].toLowerCase());
  for (const m of sql.matchAll(/\)\s*,\s*([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s*\(/gi)) local.add(m[1].toLowerCase());
  for (const m of sql.matchAll(/CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) local.add(m[1].toLowerCase());
  return local;
}

const KEYWORDS = new Set(["select", "values", "set", "where", "from", "join", "on"]);

test("every table the worker queries exists in the migrations", () => {
  const relations = definedRelations();
  assert.ok(relations.size > 200, `parsed only ${relations.size} relations — the parser is broken`);

  const unknown = new Map();
  for (const file of walk(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const lit of src.matchAll(/`([^`]*)`/g)) {
      const sql = lit[1];
      if (!/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(sql)) continue;
      const local = locallyDefined(sql);
      for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)\b/gi)) {
        const name = m[1].toLowerCase();
        if (KEYWORDS.has(name) || relations.has(name) || BUILTIN.has(name) || local.has(name)) continue;
        if (!unknown.has(name)) unknown.set(name, new Set());
        unknown.get(name).add(relative(ROOT, file));
      }
    }
  }

  const surprises = [...unknown.keys()].filter((n) => !KNOWN_ABSENT.has(n)).sort();
  assert.deepEqual(
    surprises, [],
    "these queries name tables no migration creates, and every one of them " +
    "fails silently at runtime:\n" +
    surprises.map((n) => `  ${n}\n    ${[...unknown.get(n)].join("\n    ")}`).join("\n") +
    "\n\nEither create the table, repoint the query, or — if the feature is " +
    "genuinely unbuilt — add it to KNOWN_ABSENT with the reason.",
  );
});

test("the known-absent list has not gone stale", () => {
  // An entry that no longer appears means the table was created or the query
  // repointed. Drop it, so the list keeps meaning what it says.
  const relations = definedRelations();
  const referenced = new Set();
  for (const file of walk(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const lit of src.matchAll(/`([^`]*)`/g)) {
      const sql = lit[1];
      if (!/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(sql)) continue;
      for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)\b/gi)) {
        referenced.add(m[1].toLowerCase());
      }
    }
  }
  const stale = [...KNOWN_ABSENT.keys()].filter((n) => !referenced.has(n) || relations.has(n));
  assert.deepEqual(stale, [], `KNOWN_ABSENT entries that are no longer absent or no longer referenced: ${stale.join(", ")}`);
});

test("the tables the renames repointed to really exist", () => {
  // Pins the six renames this change made, so a future edit cannot quietly
  // reintroduce the old name.
  const relations = definedRelations();
  for (const t of ["news_items", "news_entity_mentions", "conference_attendance",
                   "entity_profile_axes", "channels", "facts"]) {
    assert.ok(relations.has(t), `${t} must exist — a rename points at it`);
  }
  for (const gone of ["news_articles", "entity_mentions", "conference_attendees",
                      "profile_axes", "u_channels", "u_facts"]) {
    assert.ok(!relations.has(gone), `${gone} should not exist; if it was added, revisit the renames`);
  }
});
