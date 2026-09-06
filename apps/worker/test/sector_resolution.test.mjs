// Every sector lookup in the platform read predicates nothing writes.
//
// Four call sites in the valuation module and one in the edge-quality sweep
// asked `facts` for `company.sector`, `firm.sector` or `sector`. No writer in
// the worker produces any of the three. What exists is the PLURAL
// `firm.sectors` (a JSON array in value_json, from the profile workflows),
// `industry` (value_text, from the account dual-write), and
// entity_summary.sectors_csv (the materialised slug list the summary rebuild
// derives from `sector` tags).
//
// In the comp panel that is worse than returning everything: a sector miss
// `continue`s past the candidate, so an operator filtering by sector got an
// EMPTY panel and the reasonable conclusion that nothing was comparable.
//
// entities/sector.ts is now the single place that knows the storage shapes.
// Its SQL is lifted out of the source and executed against the real
// migrations, because a query that parses, runs and matches nothing is
// exactly what this is about.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src/entities/sector.ts"), "utf8");

function db() {
  const d = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }
  return d;
}

function hasSectorSql() {
  const m = SRC.match(/`(SELECT 1 AS hit FROM entity_summary s[\s\S]*?)`/);
  assert.ok(m, "entityHasSector's statement changed shape");
  return m[1];
}

let seq = 0;
const org = (d, id, name = id) =>
  d.prepare("INSERT INTO u_entities (id, kind, display_name) VALUES (?, 'org', ?)").run(id, name);
const summary = (d, id, csv) =>
  d.prepare("INSERT INTO entity_summary (entity_id, kind, sectors_csv) VALUES (?, 'org', ?)").run(id, csv);
const fact = (d, id, predicate, { text = null, json = null } = {}) =>
  d.prepare(
    `INSERT INTO facts (id, entity_id, predicate, value_text, value_json,
                        source_kind, source, confidence, hash)
     VALUES (?, ?, ?, ?, ?, 'scrape', 'test', 0.8, ?)`,
  ).run(`f${++seq}`, id, predicate, text, json, `h${seq}`);

const has = (d, id, sector) =>
  d.prepare(hasSectorSql()).all(id, sector, id, sector, sector).length > 0;

test("the module still exports what the call sites import", () => {
  for (const name of ["entityHasSector", "entityPrimarySector", "SECTOR_MATCHES_COMPANY_ENTITY_SQL"]) {
    assert.match(SRC, new RegExp(`export (?:async function|function|const) ${name}\\b`), `${name} missing`);
  }
});

test("matches the materialised entity_summary.sectors_csv", () => {
  const d = db(); org(d, "c1"); summary(d, "c1", "fintech,saas");
  assert.equal(has(d, "c1", "SaaS"), true, "match must be case-insensitive");
  assert.equal(has(d, "c1", "biotech"), false);
});

test("sectors_csv matching is delimited, not a substring test", () => {
  // "fin" inside "fintech" must not match, or every sector filter widens.
  const d = db(); org(d, "c2"); summary(d, "c2", "fintech");
  assert.equal(has(d, "c2", "fin"), false);
  assert.equal(has(d, "c2", "tech"), false);
  assert.equal(has(d, "c2", "fintech"), true);
});

test("matches the PLURAL firm.sectors JSON array — what writers emit", () => {
  const d = db(); org(d, "c3");
  fact(d, "c3", "firm.sectors", { json: JSON.stringify(["Climate", " Energy "]) });
  assert.equal(has(d, "c3", "climate"), true);
  assert.equal(has(d, "c3", "energy"), true, "array members are trimmed before comparison");
  assert.equal(has(d, "c3", "fintech"), false);
});

test("matches `industry` — what the account dual-write emits", () => {
  const d = db(); org(d, "c4");
  fact(d, "c4", "industry", { text: " Logistics " });
  assert.equal(has(d, "c4", "logistics"), true);
});

test("the singular predicates still match if anything ever writes one", () => {
  const d = db(); org(d, "c5");
  fact(d, "c5", "company.sector", { text: "Healthcare" });
  assert.equal(has(d, "c5", "healthcare"), true);
});

test("a superseded fact does not match", () => {
  const d = db(); org(d, "c6");
  fact(d, "c6", "industry", { text: "Logistics" });
  d.prepare("UPDATE facts SET is_current = 0 WHERE entity_id = ?").run("c6");
  assert.equal(has(d, "c6", "logistics"), false);
});

test("an unrelated predicate is not treated as a sector", () => {
  const d = db(); org(d, "c7");
  fact(d, "c7", "person.title", { text: "Fintech" });
  assert.equal(has(d, "c7", "fintech"), false);
});

test("an empty sector argument matches nothing", () => {
  const d = db(); org(d, "c8"); summary(d, "c8", "fintech");
  assert.equal(has(d, "c8", ""), false,
    "an empty filter must not silently match every entity");
});

test("the valuation call sites use the helper rather than their own SQL", () => {
  const comp = readFileSync(join(ROOT, "src/services/valuation/compPanel.ts"), "utf8");
  const impl = readFileSync(join(ROOT, "src/services/valuation/impliedValuation.ts"), "utf8");
  assert.match(comp, /entityHasSector\(env, r\.company_entity_id, criteria\.sector\)/);
  assert.match(comp, /SECTOR_MATCHES_COMPANY_ENTITY_SQL/);
  assert.match(impl, /entityPrimarySector\(env, entityId\)/);
  for (const [name, s] of [["compPanel", comp], ["impliedValuation", impl]]) {
    assert.ok(!/predicate IN \('company\.sector','firm\.sector','sector'\)/.test(s),
      `${name} still has its own writer-less sector query`);
  }
});
