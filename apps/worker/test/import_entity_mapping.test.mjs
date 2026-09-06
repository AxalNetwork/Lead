// The LinkedIn "Connections.csv" regression.
//
// A person-shaped export was imported through the legacy path and produced
// thousands of lead rows whose NAME column held employer strings ("Plug and
// Play Tech Center" ten times over, "Self-employed", "Zelfstandig /
// Eigenaar", "Stealth AI Startup") with org and email empty.
//
// Three faults compounded:
//   1. `reg()` is first-write-wins and firms.name registers "company" /
//      "organization" / "org" / "firm" before leads.org exists, so a plain
//      "Company" header mapped to firms.name at confidence 1.00.
//   2. The fuzzy tier matched "First Name" to "firm name" at edit distance
//      2 against a tolerance of 3.
//   3. projectAndCoerceRow read only `m.field` and never `m.entity`, so
//      both of those wrote straight into leads.name — and "Company", being
//      last in column order, won.
//
// Fault 3 is the load-bearing one and is what these tests mostly pin.

import { test } from "node:test";
import assert from "node:assert/strict";

const { reconcileToIntent, autoMapHeader, autoMapHeaders } = await import(
  "../test-dist/imports/auto_map.js"
);

// ---- fault 3: the entity half of the mapping is now honoured -----------

test("a firm's name becomes the person's employer on a people tab", () => {
  assert.deepEqual(
    reconcileToIntent({ entity: "firms", field: "name" }, "leads"),
    { entity: "leads", field: "org" },
  );
});

test("matching entities pass through untouched", () => {
  const m = { entity: "leads", field: "title" };
  assert.deepEqual(reconcileToIntent(m, "leads"), m);
  const f = { entity: "firms", field: "thesis" };
  assert.deepEqual(reconcileToIntent(f, "firms"), f);
});

test("a foreign mapping with no equivalent is dropped, not written through", () => {
  // A firm's thesis is not a property of a person. Previously this landed
  // in leads.thesis purely because both tables happen to have that column.
  assert.equal(reconcileToIntent({ entity: "firms", field: "thesis" }, "leads"), null);
  assert.equal(reconcileToIntent({ entity: "leads", field: "seniority" }, "firms"), null);
});

test("the reverse direction works for org tabs", () => {
  assert.deepEqual(
    reconcileToIntent({ entity: "leads", field: "org" }, "firms"),
    { entity: "firms", field: "name" },
  );
  assert.deepEqual(
    reconcileToIntent({ entity: "leads", field: "email" }, "firms"),
    { entity: "firms", field: "contact_email" },
  );
});

test("metric tabs are passed through — they legitimately mix entities", () => {
  // firm_metrics rows carry firms.* columns to resolve which firm the row
  // is about, so the guard must not strip them.
  const m = { entity: "firms", field: "name" };
  assert.deepEqual(reconcileToIntent(m, "firm_metrics"), m);
  assert.deepEqual(reconcileToIntent(m, "firm_geo"), m);
});

// ---- fault 2: "First Name" no longer collides with "firm name" ---------

test('"First Name" maps to a person field, not a firm', () => {
  const m = autoMapHeader("First Name");
  assert.ok(m, "First Name should map to something");
  assert.equal(m.entity, "leads", `expected a leads field, got ${m.entity}.${m.field}`);
  assert.equal(m.field, "first_name");
});

test('"Last Name" maps to a person field', () => {
  const m = autoMapHeader("Last Name");
  assert.equal(m.entity, "leads");
  assert.equal(m.field, "last_name");
});

test("a real firm header still maps to a firm", () => {
  const m = autoMapHeader("Firm Name");
  assert.equal(m.entity, "firms");
  assert.equal(m.field, "name");
});

// ---- the whole file, end to end ---------------------------------------

test("a LinkedIn Connections.csv header row maps correctly under intent=leads", () => {
  const headers = [
    "First Name", "Last Name", "URL", "Email Address", "Company",
    "Position", "Connected On",
  ];
  const { map } = autoMapHeaders(headers);
  const resolved = {};
  for (const h of headers) {
    const m = map[h] ? reconcileToIntent(map[h], "leads") : null;
    resolved[h] = m ? `${m.entity}.${m.field}` : null;
  }

  // The bug: Company won the name field because it was mapped to
  // firms.name and written last.
  assert.equal(resolved["Company"], "leads.org",
    "the employer must land in org, never in the person's name");
  assert.notEqual(resolved["First Name"], "leads.org");
  assert.notEqual(resolved["First Name"], "firms.name");
  assert.equal(resolved["First Name"], "leads.first_name");
  assert.equal(resolved["Last Name"], "leads.last_name");
  assert.equal(resolved["Position"], "leads.title");

  // Nothing may resolve to a firms.* field on a people tab.
  const leaked = Object.entries(resolved)
    .filter(([, v]) => v && v.startsWith("firms."))
    .map(([k, v]) => `${k} -> ${v}`);
  assert.deepEqual(leaked, [], `firm fields leaked onto a people tab: ${leaked.join(", ")}`);
});

test("no header maps into the person's name except a name header", () => {
  const headers = ["Company", "Organization", "Org", "Firm", "Employer"];
  const { map } = autoMapHeaders(headers);
  for (const h of headers) {
    const m = map[h] ? reconcileToIntent(map[h], "leads") : null;
    if (!m) continue;
    assert.notEqual(m.field, "name",
      `"${h}" must not write the person's name (it resolved to ${m.entity}.${m.field})`);
  }
});

// ---- fault 2, stated as the rule rather than the one symptom ----------

test("short aliases need a near-exact fuzzy match; long ones stay lenient", () => {
  // Two edits is a large fraction of a nine-character alias, and distinct
  // headers sit that close together constantly ("first name" is two edits
  // from "firm name"). One edit on a short alias still resolves, so genuine
  // typos are not lost, and long aliases keep the old 25% tolerance.
  const twoEditsShort = autoMapHeader("Frim Name"); // 2 edits from "firm name"
  assert.ok(
    !twoEditsShort || twoEditsShort.confidence >= 0.85,
    `a 2-edit match on a short alias must not resolve via the fuzzy tier; ` +
      `got ${twoEditsShort && `${twoEditsShort.entity}.${twoEditsShort.field}@${twoEditsShort.confidence}`}`,
  );

  const oneEditShort = autoMapHeader("Contact Nome"); // 1 edit from "contact name"
  assert.equal(oneEditShort?.entity, "leads");
  assert.equal(oneEditShort?.field, "name");

  const oneEditLong = autoMapHeader("Personal Emai"); // 1 edit from "personal email"
  assert.equal(oneEditLong?.entity, "leads");
  assert.equal(oneEditLong?.field, "email");
});
