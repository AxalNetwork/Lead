// Per-sector PageRank ran on an empty sector map, on every sweep.
//
// loadPrimarySectors drives the partition that computeInfluence uses for
// per-sector PageRank and the per-sector power-node flags. It read three
// predicates from `facts`: entity.primary_sector, firm.sector and
// company.sector. Nothing in the worker writes any of the three — the profile
// workflows emit the PLURAL `firm.sectors` as a JSON array, the account
// dual-write emits `industry`, and both end up as `sector` tags that the
// summary rebuild materialises into entity_summary.sectors_csv.
//
// So the map came back empty every time, every node landed in one unsectored
// bucket, and sectors_ranked was 0 — indistinguishable from a graph that
// genuinely has no sector data, which is why it went unnoticed.
//
// Executed against the real migrations rather than pattern-matched: the whole
// failure was a query that parsed, ran, and returned nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src/services/edgeQuality/sweep.ts"), "utf8");

function db() {
  const d = new DatabaseSync(":memory:");
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }
  return d;
}

/** Lift both queries out of the source so test and implementation cannot drift. */
function queries() {
  const summary = SRC.match(/`(SELECT entity_id, sectors_csv[\s\S]*?)`/);
  const facts = SRC.match(/`(SELECT entity_id, value_text, value_json[\s\S]*?)`/);
  assert.ok(summary, "the entity_summary sector query changed shape");
  assert.ok(facts, "the facts sector fallback changed shape");
  // One placeholder per bound id; the tests bind exactly one.
  return {
    summary: summary[1].replace(/\$\{[^}]*\}/, "?"),
    facts: facts[1].replace(/\$\{[^}]*\}/, "?"),
  };
}

let seq = 0;
const ent = (d, id) => d.prepare("INSERT INTO u_entities (id, kind, display_name) VALUES (?, 'org', ?)").run(id, id);
const fact = (d, id, predicate, { text = null, json = null } = {}) =>
  d.prepare(
    `INSERT INTO facts (id, entity_id, predicate, value_text, value_json,
                        source_kind, source, confidence, hash)
     VALUES (?, ?, ?, ?, ?, 'scrape', 'test', 0.8, ?)`,
  ).run(`f${++seq}`, id, predicate, text, json, `h${seq}`);

/** Mirrors loadPrimarySectors: summary first, facts for what is left. */
function resolve(d, id) {
  const q = queries();
  const s = d.prepare(q.summary).all(id);
  for (const row of s) {
    const first = (row.sectors_csv ?? "").split(",").map((x) => x.trim()).find(Boolean);
    if (first) return first.toLowerCase();
  }
  for (const row of d.prepare(q.facts).all(id)) {
    const v = row.value_text?.trim() || firstOfJson(row.value_json);
    if (v) return v.toLowerCase();
  }
  return null;
}
function firstOfJson(raw) {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!Array.isArray(p)) return null;
    for (const x of p) if (typeof x === "string" && x.trim()) return x.trim();
  } catch { /* not JSON */ }
  return null;
}

test("entity_summary.sectors_csv resolves — it is the materialised source", () => {
  const d = db();
  ent(d, "e1");
  d.prepare("INSERT INTO entity_summary (entity_id, kind, sectors_csv) VALUES (?, 'org', ?)")
    .run("e1", "Fintech,SaaS");
  assert.equal(resolve(d, "e1"), "fintech");
});

test("the PLURAL firm.sectors JSON array resolves — this is what writers emit", () => {
  const d = db();
  ent(d, "e2");
  fact(d, "e2", "firm.sectors", { json: JSON.stringify(["Climate", "Energy"]) });
  assert.equal(resolve(d, "e2"), "climate",
    "firm.sectors is written as a JSON array by the profile workflows; the old query read only value_text on the singular name");
});

test("`industry` resolves — this is what the account dual-write emits", () => {
  const d = db();
  ent(d, "e3");
  fact(d, "e3", "industry", { text: "Logistics" });
  assert.equal(resolve(d, "e3"), "logistics");
});

test("the singular predicates still resolve if anything ever writes one", () => {
  const d = db();
  ent(d, "e4");
  fact(d, "e4", "entity.primary_sector", { text: "Healthcare" });
  assert.equal(resolve(d, "e4"), "healthcare");
});

test("an entity with no sector evidence stays unsectored", () => {
  const d = db();
  ent(d, "e5");
  fact(d, "e5", "person.title", { text: "Partner" });
  assert.equal(resolve(d, "e5"), null, "an unrelated predicate must not become a sector");
});

test("a summary row with an empty sectors_csv falls through to facts", () => {
  const d = db();
  ent(d, "e6");
  d.prepare("INSERT INTO entity_summary (entity_id, kind, sectors_csv) VALUES (?, 'org', ?)").run("e6", "");
  fact(d, "e6", "firm.sectors", { json: JSON.stringify(["Biotech"]) });
  assert.equal(resolve(d, "e6"), "biotech",
    "an entity whose summary has been rebuilt with no tags must still use its facts");
});

test("a non-array value_json does not crash the fallback", () => {
  const d = db();
  ent(d, "e7");
  fact(d, "e7", "firm.sectors", { json: '{"not":"an array"}' });
  assert.equal(resolve(d, "e7"), null);
});
