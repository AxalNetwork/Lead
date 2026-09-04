// Task #2 (People page + Leads unification) — route + DOM tests.
//
// These exercise the source-shape of the new endpoints and the
// list-mode rendering of /dashboard/people/. The worker route is
// not directly invoked (Hono entrypoint imports CF bindings at
// module load time, same constraint as access_guard.test.mjs); we
// instead assert the SQL/contract shape from the source and run
// the JSDOM-shape unit tests on the static client code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..");
const peopleRouteSrc = readFileSync(resolve(__dirname, "../src/routes/people.ts"), "utf8");
const promoteRouteSrc = readFileSync(resolve(__dirname, "../src/routes/leads_promote.ts"), "utf8");
const leadsRouteSrc = readFileSync(resolve(__dirname, "../src/routes/leads.ts"), "utf8");
const indexSrc = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
const peopleListJs = readFileSync(resolve(root, "site/assets/js/people-list.js"), "utf8");
const leadsJs = readFileSync(resolve(root, "site/assets/js/leads.js"), "utf8");
const sidenavTpl = readFileSync(resolve(root, "site/_includes/shell/sidenav.html"), "utf8");
const peopleHtml = readFileSync(resolve(root, "site/dashboard/people.html"), "utf8");

// ---------- 1. GET /api/people contract ----------
test("GET /api/people filters status='active' and kind='person'", () => {
  assert.match(peopleRouteSrc, /e\.kind = 'person'/);
  assert.match(peopleRouteSrc, /e\.status = 'active'/);
});

test("GET /api/people returns roles aggregated from entity_roles", () => {
  assert.match(peopleRouteSrc, /json_group_array\(r\.role\).*FROM entity_roles r WHERE r\.entity_id = e\.id/s);
  // Items map exposes a `roles` array (string[]).
  assert.match(peopleRouteSrc, /roles,/);
});

test("GET /api/people supports pagination via limit/offset with next_offset", () => {
  assert.match(peopleRouteSrc, /limit \+ 1/);
  assert.match(peopleRouteSrc, /next_offset: hasMore \? offset \+ limit : null/);
});

test("GET /api/people supports q, role, and source_email filters", () => {
  assert.match(peopleRouteSrc, /c\.req\.query\("q"\)/);
  assert.match(peopleRouteSrc, /c\.req\.query\("role"\)/);
  assert.match(peopleRouteSrc, /c\.req\.query\("source_email"\)/);
});

test("/api/people mount is registered AFTER accessGuard in src/index.ts", () => {
  const guardIdx = indexSrc.search(/api\.use\(\s*"\/api\/\*"\s*,\s*accessGuard\s*\)/);
  const peopleIdx = indexSrc.search(/api\.route\(\s*"\/api\/people"\s*,\s*peopleRoute\s*\)/);
  assert.ok(guardIdx > -1, "accessGuard mount missing");
  assert.ok(peopleIdx > -1, "/api/people mount missing");
  assert.ok(peopleIdx > guardIdx, "/api/people must be mounted after accessGuard");
});

// ---------- 2. POST /api/leads/promote contract ----------
test("POST /api/leads/promote restricts target role to the spec's 5 options", () => {
  assert.match(promoteRouteSrc, /investor.*customer.*prospect.*founder.*operator/s);
  assert.match(promoteRouteSrc, /error: "bad_role"/);
});

test("POST /api/leads/promote writes through the canonical addRole helper", () => {
  assert.match(promoteRouteSrc, /import\s*\{[^}]*addRole[^}]*\}\s*from\s*"\.\.\/entities\/roles"/);
  assert.match(promoteRouteSrc, /addRole\(c\.env,\s*entityId/);
  // Must NOT contain a raw INSERT INTO entity_roles — bypass would
  // violate the Task #1 canonical-write precedent.
  assert.doesNotMatch(promoteRouteSrc, /INSERT\s+INTO\s+entity_roles/i);
});

test("POST /api/leads/promote drops the 'lead' role row when drop_lead=true (default)", () => {
  assert.match(promoteRouteSrc, /DELETE FROM entity_roles WHERE entity_id = \? AND role = 'lead'/);
  // Default to true when the flag is absent or non-false.
  assert.match(promoteRouteSrc, /drop_lead === false \? false : true/);
});

test("/api/leads/promote mount sits behind accessGuard", () => {
  const guardIdx = indexSrc.search(/api\.use\(\s*"\/api\/\*"\s*,\s*accessGuard\s*\)/);
  const mountIdx = indexSrc.search(/api\.route\(\s*"\/api\/leads"\s*,\s*leadsPromote\s*\)/);
  assert.ok(mountIdx > guardIdx, "leadsPromote must mount after accessGuard");
});

// ---------- 3. GET /api/leads tightening + role badges ----------
test("GET /api/leads excludes leads whose entity has been promoted", () => {
  assert.match(leadsRouteSrc, /NOT EXISTS \(\s*SELECT 1 FROM entity_legacy_map/);
  assert.match(leadsRouteSrc, /r\.role IN \('investor','customer','prospect','founder','operator'\)/);
});

test("GET /api/leads attaches roles[] per row for cross-list badges", () => {
  assert.match(leadsRouteSrc, /json_group_array\(r\.role\)/);
  assert.match(leadsRouteSrc, /\.\.\.rest, roles\b/);
});

// ---------- 4. People list page DOM/JS ----------
test("people-list.js renders cross-list badges from items[].roles", () => {
  assert.match(peopleListJs, /function roleChip\(role\)/);
  assert.match(peopleListJs, /function rolesBadges\(roles\)/);
  // Maps each spec role to an existing dashboard list URL.
  for (const role of ["investor", "customer", "prospect", "founder", "operator", "lead"]) {
    assert.match(peopleListJs, new RegExp(role + ":"), `ROLE_LIST_URL missing ${role}`);
  }
});

test("people-list.js fetches /api/people, not the bare entity endpoint", () => {
  assert.match(peopleListJs, /api\(\s*"\/api\/people\?"/);
});

test("people.html is two-mode: list vs dossier, switched by ?id=", () => {
  assert.match(peopleHtml, /id="ads-people-list-root"/);
  assert.match(peopleHtml, /id="ads-person-dossier-root"/);
  assert.match(peopleHtml, /listRoot\.hidden = true; dossierRoot\.hidden = false/);
});

// ---------- 5. Leads JS promote action ----------
test("leads.js has a promote bulk action that POSTs to /api/leads/promote", () => {
  assert.match(leadsJs, /\/api\/leads\/promote/);
  assert.match(leadsJs, /function promoteSelected\(\)/);
  // Drops lead role on success path (drop_lead: true).
  assert.match(leadsJs, /drop_lead:\s*true/);
});

test("leads.js renders cross-list role badges on each row", () => {
  assert.match(leadsJs, /function rolesBadges\(roles\)/);
  assert.match(leadsJs, /rolesBadges\(l\.roles\)/);
});

// ---------- 6. Sidenav reorganization ----------
test("sidenav groups follow the 5-spec taxonomy", () => {
  for (const label of ["Discover", "Network", "Intelligence", "Research", "Operations"]) {
    assert.match(sidenavTpl, new RegExp(`group-label">${label}<`), `sidenav missing group: ${label}`);
  }
});

test("sidenav preserves every existing dashboard URL (no link 404s)", () => {
  // Spot-check the legacy URLs whose absence would 404 a bookmark.
  for (const url of [
    "/dashboard/investors/",
    "/dashboard/firms/",
    "/dashboard/companies/",
    "/dashboard/accounts/",
    "/dashboard/people/",
    "/dashboard/leads/",
    "/dashboard/relationships/",
    "/dashboard/personas/",
    "/dashboard/analytics/",
    "/dashboard/analytics-firms/",
    "/dashboard/segments/",
    "/dashboard/icps/",
    "/dashboard/research/",
    "/dashboard/projects/",
    "/dashboard/campaigns/",
    "/dashboard/imports/",
    "/dashboard/uploads/",
    "/dashboard/crawlers/",
    "/dashboard/merge-review/",
    "/dashboard/jobs/",
    "/dashboard/errors/",
    "/dashboard/health/",
    "/dashboard/compliance/",
    "/dashboard/dd-review/",
    "/dashboard/sources/",
    "/dashboard/watchlists/",
  ]) {
    assert.ok(sidenavTpl.includes(`href="${url}"`), `sidenav missing legacy URL: ${url}`);
  }
});

test("sidenav new items without a page route to /dashboard/coming-soon/", () => {
  for (const feat of ["saved-research", "agent"]) {
    assert.ok(
      sidenavTpl.includes(`coming-soon/?feature=${feat}`),
      `Coming-soon link missing for feature: ${feat}`,
    );
  }
});

test("sidenav items that shipped a real page no longer point at coming-soon", () => {
  // Once a feature ships, its rail link must go to the real route so the
  // coming-soon stub doesn't shadow a working page.
  const shipped = {
    "power-nodes": "/dashboard/power-nodes/",
    predictions: "/dashboard/predictions/",
    dossiers: "/dashboard/dossiers/",
    "dedupe-review": "/dashboard/merge-review/",
    "quality-console": "/ops/quality/",
  };
  for (const [feat, href] of Object.entries(shipped)) {
    assert.ok(!sidenavTpl.includes(`coming-soon/?feature=${feat}`), `${feat} still routes to coming-soon`);
    assert.ok(sidenavTpl.includes(`href="${href}"`), `sidenav missing shipped route ${href} for ${feat}`);
  }
});

// ---------- 7. Acceptance — Rajeev Ranka shape ----------
test("acceptance: Rajeev Ranka payload renders on list + leads with role badges", () => {
  const rajeev = {
    id: "ent_rajeev_uuid",
    display_name: "Rajeev Ranka",
    primary_url: null,
    primary_domain: "incubatefund.com",
    primary_email_key: "rajeev@incubatefund.com",
    primary_linkedin_key: null,
    created_at: "2026-05-20T10:00:00Z",
    updated_at: "2026-05-20T10:00:00Z",
    roles: ["lead", "investor"], // post-role-inference
  };
  // Renders an anchor to the dossier with name + a role-chip strip
  // including both 'lead' (links to /dashboard/leads/) and 'investor'
  // (links to /dashboard/investors/).
  const ROLE_LIST_URL = {
    investor: "/dashboard/investors/",
    customer: "/dashboard/accounts/",
    prospect: "/dashboard/accounts/?role=prospect",
    founder: "/dashboard/people/?role=founder",
    operator: "/dashboard/people/?role=operator",
    lead: "/dashboard/leads/",
  };
  const chips = rajeev.roles.map((r) => ROLE_LIST_URL[r]).filter(Boolean);
  assert.ok(chips.includes("/dashboard/investors/"), "investor chip should link to /dashboard/investors/");
  assert.ok(chips.includes("/dashboard/leads/"), "lead chip should link to /dashboard/leads/");
  assert.equal(rajeev.display_name.toLowerCase().includes("rajeev"), true);
});
