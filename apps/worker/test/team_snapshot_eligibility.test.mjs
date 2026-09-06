// The weekly firm team-page snapshot picked zero firms, forever.
//
// runWeeklySnapshotSweep is the producer for firm_team_snapshots, which the
// spinout detector (movements/spinout.ts) reads to notice partners leaving.
// Its eligibility query required BOTH:
//
//   * a current `firm.team_url` fact — a predicate no writer in the worker
//     produces, and
//   * entity_roles.role = 'investor_firm' — assigned only by
//     deals/investorResolver, while every firm that got its role from the
//     dual-write carries 'firm'.
//
// Either alone was fatal. The sweep returned picked:0, which is also exactly
// what "every firm is already up to date" looks like, so it never surfaced.
//
// firm_people.source_url is the URL scraper/pipeline.ts actually parsed the
// firm's people from — the only populated team-page URL in the schema. The
// query now falls back to it, and matches the same role set its sibling
// detector uses.
//
// Executed against the real migrations: this was a query that parsed, ran,
// and returned nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src/services/movements/snapshot.ts"), "utf8");

function sweepSql() {
  const m = SRC.match(/`(WITH candidates AS \([\s\S]*?LIMIT \?)`/);
  assert.ok(m, "the sweep's eligibility query changed shape");
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
function firm(d, { entityId, role = "firm", legacyId = null, teamUrlFact = null, peopleUrl = null }) {
  d.prepare("INSERT INTO u_entities (id, kind, display_name) VALUES (?, 'org', ?)").run(entityId, entityId);
  d.prepare("INSERT INTO entity_roles (entity_id, role, source) VALUES (?, ?, 'test')").run(entityId, role);
  if (teamUrlFact) {
    d.prepare(
      `INSERT INTO facts (id, entity_id, predicate, value_text, source_kind, source, confidence, hash)
       VALUES (?, ?, 'firm.team_url', ?, 'scrape', 'test', 0.9, ?)`,
    ).run(`f${++seq}`, entityId, teamUrlFact, `h${seq}`);
  }
  if (peopleUrl != null) {
    d.prepare("INSERT INTO firms (id, name) VALUES (?, ?)").run(legacyId, entityId);
    d.prepare("INSERT INTO entity_legacy_map (legacy_table, legacy_id, entity_id) VALUES ('firms', ?, ?)")
      .run(String(legacyId), entityId);
    // firm_people.lead_id is NOT NULL — every row is a person on a firm.
    d.prepare("INSERT INTO leads (id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))").run(`lead${legacyId}`, "A Partner");
    d.prepare("INSERT INTO firm_people (firm_id, lead_id, role, source_url) VALUES (?, ?, 'Partner', ?)")
      .run(legacyId, `lead${legacyId}`, peopleUrl);
  }
}

const sweep = (d, limit = 25) => d.prepare(sweepSql()).all(limit);

test("a firm whose people were scraped is eligible — the populated source", () => {
  const d = db();
  firm(d, { entityId: "e1", role: "firm", legacyId: 1, peopleUrl: "https://acme.vc/team" });
  assert.deepEqual(sweep(d).map((r) => [r.firm_entity_id, r.team_url]),
    [["e1", "https://acme.vc/team"]],
    "the old query required a firm.team_url fact, which nothing writes");
});

test("role 'firm' is eligible — the dual-write's role, not just investor_firm", () => {
  const d = db();
  firm(d, { entityId: "e2", role: "firm", legacyId: 2, peopleUrl: "https://b.vc/people" });
  assert.equal(sweep(d).length, 1);
});

test("role 'investor_firm' still works", () => {
  const d = db();
  firm(d, { entityId: "e3", role: "investor_firm", legacyId: 3, peopleUrl: "https://c.vc/team" });
  assert.equal(sweep(d).length, 1);
});

test("an explicit firm.team_url fact wins over the scraped page", () => {
  const d = db();
  firm(d, {
    entityId: "e4", role: "firm", legacyId: 4,
    teamUrlFact: "https://override.vc/our-team",
    peopleUrl: "https://override.vc/stale",
  });
  const rows = sweep(d);
  assert.equal(rows.length, 1, "the two sources must collapse to one row per firm");
  assert.equal(rows[0].team_url, "https://override.vc/our-team",
    "an operator override must not lose to a scraped URL");
});

test("a non-firm entity is not swept", () => {
  const d = db();
  firm(d, { entityId: "e5", role: "founder", legacyId: 5, peopleUrl: "https://person.example/bio" });
  assert.deepEqual(sweep(d), []);
});

test("a firm snapshotted within 7 days is skipped, and one older is picked", () => {
  const d = db();
  firm(d, { entityId: "fresh", role: "firm", legacyId: 6, peopleUrl: "https://f.vc/team" });
  firm(d, { entityId: "stale", role: "firm", legacyId: 7, peopleUrl: "https://s.vc/team" });
  const snap = (id, days) => d.prepare(
    `INSERT INTO firm_team_snapshots (id, firm_entity_id, snapshot_date, source_url, members_json, members_count)
     VALUES (?, ?, date('now', ?), 'x', '[]', 0)`,
  ).run(`s${id}`, id, `-${days} days`);
  snap("fresh", 1);
  snap("stale", 30);
  assert.deepEqual(sweep(d).map((r) => r.firm_entity_id), ["stale"]);
});

test("a firm with no team page anywhere is not swept", () => {
  const d = db();
  firm(d, { entityId: "e6", role: "firm" });
  assert.deepEqual(sweep(d), [], "an empty source_url must not become a crawl target");
});
