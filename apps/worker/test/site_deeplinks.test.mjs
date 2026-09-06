// Dashboard deep links that pointed at pages which could not read them.
//
// Three separate faults, all with the same signature: the page loaded, the
// chrome rendered, and the content was empty. Nothing errored, so each one
// read as "we have no data on this entity" rather than "this link is wrong".
//
//   1. Seven links across six pages open /dashboard/profile/?id=<entity>.
//      profile-tab.js read only `?entity=`, so all seven showed
//      "No entity selected."
//   2. leads.js linked every name to /dashboard/people/?id=<leads.id>.
//      That page feeds the value to /api/profilers/:entity_id/*, which is
//      keyed on u_entities — a legacy integer id can never match a uuid.
//   3. bulk-bar.js resolved #ads-bulk-header-check once at init(). On
//      investors and companies that element is emitted inside the async row
//      render, so it did not exist yet; "select page" and "select all
//      matching" were dead there while working on leads and accounts.
//
// The site has no JS test runner, so these are static assertions over the
// files — the same approach ci_wrangler_version.test.mjs takes for the
// workflow YAML.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "../../site");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor" || name === "_site") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = walk(SITE);
const read = (rel) => readFileSync(join(SITE, rel), "utf8");

test("the site tree is where this test thinks it is", () => {
  assert.ok(FILES.length > 50, `expected the dashboard sources, found ${FILES.length} files`);
  assert.ok(FILES.some((f) => f.endsWith("assets/js/profile-tab.js")));
});

// ---- 1. /dashboard/profile/ deep links ---------------------------------

test("profile-tab.js reads every query param the site links to it with", () => {
  const src = read("assets/js/profile-tab.js");
  // The params the reader honours, from the qs() destructure.
  const qs = src.match(/function qs\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(qs, "qs() not found — the shape of profile-tab.js changed");

  const used = new Set();
  for (const f of FILES) {
    for (const m of readFileSync(f, "utf8").matchAll(/\/dashboard\/profile\/\?([a-z_]+)=/g)) {
      used.add(m[1]);
    }
  }
  assert.ok(used.size > 0, "no /dashboard/profile/ links found — the scan is broken");

  const unread = [...used].filter((p) => !new RegExp(`p\\.get\\("${p}"\\)`).test(qs[0]));
  assert.deepEqual(unread, [],
    `pages deep-link /dashboard/profile/ with these params, and qs() ignores them, ` +
    `so the page renders "No entity selected": ${unread.join(", ")}`);
});

// ---- 2. the Leads list id space ----------------------------------------

test("leads.js does not send a legacy leads id to an entity-keyed page", () => {
  const src = read("assets/js/leads.js");
  assert.ok(!/\/dashboard\/people\/\?id=['"]\s*\+\s*(?:esc|encodeURIComponent)\(l\.id\)/.test(src),
    "leads.js links a leads.id at /dashboard/people/, which resolves it against u_entities");
  assert.ok(/l\.entity_id/.test(src),
    "leads.js should link the unified entity id when the listing carries one");
});

test("the leads listing actually returns the entity_id leads.js links with", () => {
  const route = readFileSync(join(SITE, "../worker/src/routes/leads.ts"), "utf8");
  assert.ok(/AS entity_id/.test(route),
    "GET /api/leads must select entity_id or leads.js has nothing to link to");
});

// ---- 3. the bulk-bar header checkbox -----------------------------------

test("bulk-bar binds the header checkbox by delegation, not by init-time lookup", () => {
  const src = read("assets/js/bulk-bar.js");
  assert.ok(!/getElementById\(\s*["']ads-bulk-header-check["']\s*\)/.test(src),
    "resolving the header checkbox at init() misses the pages that render it asynchronously");
  assert.ok(/closest\(\s*["']#ads-bulk-header-check["']\s*\)/.test(src),
    "bulk-bar should match the header checkbox on a delegated click");
});

test("the pages that render the header checkbox asynchronously still declare it", () => {
  // If a page stops emitting the id the delegated handler is inert — silently,
  // which is the failure mode this whole file exists to catch.
  const emitters = FILES.filter((f) => /id="ads-bulk-header-check"/.test(readFileSync(f, "utf8")))
    .map((f) => relative(SITE, f)).sort();
  for (const expected of [
    "assets/js/companies.js", "assets/js/investors.js",
    "dashboard/accounts.html", "dashboard/leads/index.html",
  ]) {
    assert.ok(emitters.includes(expected), `${expected} no longer renders #ads-bulk-header-check`);
  }
});
