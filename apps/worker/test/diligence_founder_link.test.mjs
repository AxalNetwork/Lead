// The founder-diligence section could not find founders through facts.
//
// getFoundersOf() unions two lookups: a `founder.company_founded` fact
// pointing at the company, and career_history rows whose role_title contains
// "founder". The fact branch matched on `value_entity_id`. The only writer of
// that predicate — crawler/profileWorkflows/founder.ts — stores the company
// as free TEXT in value_text, because at extraction time it has a company
// name off a bio page and no resolved entity id.
//
// So the fact branch returned nothing every time. It did not fail loudly:
// the union just silently reduced to the career_history path, and when that
// path had no row with a resolved organization_entity_id, every founder check
// on the company reported "no founders on record" rather than "we could not
// link them".
//
// Run against the real schema so the SQL is executed, not just pattern-
// matched: an equality that cannot match is exactly what got us here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src/services/diligence/checks/founders.ts"), "utf8");

/** The exact SQL the check runs, lifted from the source so they cannot drift. */
function founderSql() {
  const m = SRC.match(/`(SELECT f\.entity_id FROM facts f[\s\S]*?)`/);
  assert.ok(m, "the founder lookup in getFoundersOf changed shape");
  return m[1];
}

function db() {
  const d = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }
  return d;
}

let seq = 0;
function fact(d, { entity, predicate, text = null, entityRef = null }) {
  d.prepare(
    `INSERT INTO facts (id, entity_id, predicate, value_text, value_entity_id,
                        source_kind, source, confidence, hash)
     VALUES (?, ?, ?, ?, ?, 'scrape', 'test', 0.8, ?)`,
  ).run(`f${++seq}`, entity, predicate, text, entityRef, `h${seq}`);
}

function seedCompany(d, id, name) {
  d.prepare("INSERT INTO u_entities (id, kind, display_name) VALUES (?, 'org', ?)").run(id, name);
}
function seedPerson(d, id) {
  d.prepare("INSERT INTO u_entities (id, kind, display_name) VALUES (?, 'person', ?)").run(id, id);
}

const run = (d, companyId) =>
  d.prepare(founderSql()).all(companyId, companyId).map((r) => r.entity_id).sort();

test("a founder recorded by company NAME is found", () => {
  const d = db();
  seedCompany(d, "co1", "Acme Robotics");
  seedPerson(d, "p1");
  fact(d, { entity: "p1", predicate: "founder.company_founded", text: "  acme robotics " });
  assert.deepEqual(run(d, "co1"), ["p1"],
    "this is what the only writer of the predicate actually stores");
});

test("a founder recorded by resolved entity id is still found", () => {
  const d = db();
  seedCompany(d, "co1", "Acme Robotics");
  seedPerson(d, "p2");
  fact(d, { entity: "p2", predicate: "founder.company_founded", entityRef: "co1" });
  assert.deepEqual(run(d, "co1"), ["p2"], "the correct shape must keep working");
});

test("a different company's founder is not picked up", () => {
  const d = db();
  seedCompany(d, "co1", "Acme Robotics");
  seedCompany(d, "co2", "Globex");
  seedPerson(d, "p3");
  fact(d, { entity: "p3", predicate: "founder.company_founded", text: "Globex" });
  assert.deepEqual(run(d, "co1"), [], "name matching must not widen to every company");
});

test("an empty or whitespace company string matches nothing", () => {
  const d = db();
  seedCompany(d, "co1", "   ");
  seedPerson(d, "p4");
  fact(d, { entity: "p4", predicate: "founder.company_founded", text: "" });
  fact(d, { entity: "p4", predicate: "founder.company_founded", text: "   " });
  assert.deepEqual(run(d, "co1"), [],
    "TRIM('') = TRIM('   ') would otherwise join every blank-named row to every blank-named company");
});

test("another predicate on the same company is ignored", () => {
  const d = db();
  seedCompany(d, "co1", "Acme Robotics");
  seedPerson(d, "p5");
  fact(d, { entity: "p5", predicate: "person.employer", text: "Acme Robotics" });
  assert.deepEqual(run(d, "co1"), []);
});
