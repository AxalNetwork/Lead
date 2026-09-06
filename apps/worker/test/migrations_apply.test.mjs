// The migration chain must apply cleanly, in order, to an empty database.
//
// It did not. 005_analytics.sql created `dashboard_snapshots` as a daily KPI
// roll-up; 357_dashboards.sql later introduced a completely different table
// under the same name for user-saved dashboard views. Because both used
// CREATE TABLE IF NOT EXISTS, the second was a silent no-op and its index on
// owner_email then failed — aborting 357.
//
// wrangler applies migrations in order and stops at the first failure, so
// everything from 358 onward stayed pending: 24 migrations, and every table
// they create. 373_dashboard_snapshots_repair.sql was written to fix this and
// carries the identical bug, so it fails the same way.
//
// A schema that cannot be built from its own migrations is not a schema, and
// nothing else in this suite would have noticed: every other test builds the
// tables it needs by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "migrations");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

test("every migration applies to an empty database, in order", () => {
  const db = new DatabaseSync(":memory:");
  const failures = [];
  for (const f of FILES) {
    try { db.exec(readFileSync(join(DIR, f), "utf8")); }
    catch (e) { failures.push(`${f}: ${e.message}`); }
  }
  assert.deepEqual(
    failures, [],
    "migrations that do not apply to a fresh database:\n  " + failures.join("\n  ") +
    "\n\nwrangler stops at the first failure, so everything after it stays " +
    "pending — in production as well as here.",
  );
});

test("a failing migration would strand every migration after it", () => {
  // Guards the guard: proves the test above is load-bearing rather than
  // vacuously green, by showing what a mid-chain failure costs.
  const db = new DatabaseSync(":memory:");
  let firstFailure = -1;
  FILES.forEach((f, i) => {
    try { db.exec(readFileSync(join(DIR, f), "utf8")); }
    catch { if (firstFailure < 0) firstFailure = i; }
  });
  assert.equal(firstFailure, -1,
    `first failure is ${FILES[firstFailure]} (#${firstFailure + 1} of ${FILES.length}), ` +
    `which would strand the ${FILES.length - firstFailure - 1} migrations after it`);
});

test("the two dashboard_snapshots schemas no longer collide", () => {
  const db = new DatabaseSync(":memory:");
  for (const f of FILES) { try { db.exec(readFileSync(join(DIR, f), "utf8")); } catch { /* asserted above */ } }
  const cols = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

  // The saved-view table (357) owns the name.
  const snap = cols("dashboard_snapshots");
  for (const c of ["owner_email", "page", "filters_json", "payload_json", "row_count"]) {
    assert.ok(snap.includes(c), `dashboard_snapshots.${c} missing — routes/dashboards.ts writes it`);
  }
  // The KPI roll-up has its own table.
  const roll = cols("analytics_daily_snapshots");
  for (const c of ["snapshot_date", "total_leads", "verified_leads", "active_jobs", "exports_count"]) {
    assert.ok(roll.includes(c), `analytics_daily_snapshots.${c} missing — the nightly aggregator writes it`);
  }
  // And neither writer's statement can hit the other's table.
  assert.ok(!snap.includes("total_leads"), "the roll-up columns must not be on the saved-view table");
  assert.ok(!roll.includes("owner_email"), "the saved-view columns must not be on the roll-up table");
});

test("both dashboard_snapshots writers prepare against the built schema", () => {
  const db = new DatabaseSync(":memory:");
  for (const f of FILES) { try { db.exec(readFileSync(join(DIR, f), "utf8")); } catch { /* asserted above */ } }
  // routes/dashboards.ts
  db.prepare(`INSERT INTO dashboard_snapshots
      (id, owner_email, page, filters_json, payload_json, payload_uri, row_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // services/analytics_v2.aggregator.ts
  db.prepare(`INSERT INTO analytics_daily_snapshots
      (id, snapshot_date, total_leads, verified_leads, approved_leads,
       pending_leads, active_jobs, exports_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
});
