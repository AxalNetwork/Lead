// Cross-site writes were accepted on every mutating endpoint.
//
// accessGuard accepts the CF_Authorization cookie on its own
// (middleware/access.ts), so an ambient cookie authenticates a write — the
// exact shape CSRF exploits. Nothing in the worker checked Origin, Referer,
// Sec-Fetch-Site, or a CSRF token, across 292 mutating handlers.
//
// CORS is not a defence here. It governs whether the attacker can READ the
// response, not whether the write executes, and the preflight that blocks a
// JSON body never fires for a "simple request" — a form POST with
// application/x-www-form-urlencoded. 84 of those handlers parse no request
// body at all; they act on the path alone, so a simple form POST reaches them
// intact. One of them is POST /api/ops/garbage/:id/purge, which permanently
// deletes an entity and cascades across facts, rel_edges, channels,
// entity_roles, entity_history and entity_legacy_map.
//
// These tests EXECUTE the middleware against the repo's own Hono rather than
// pattern-matching the source, because the thing that matters is what the
// router actually does with a request — the previous gap was invisible in
// every file that looked correct on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { crossSiteGuard, ALLOWED_ORIGINS } =
  await import("../test-dist/middleware/origin.js");

const GOOD = "https://aidatasignal.com";
const EVIL = "https://evil.example";

/**
 * A router shaped like the real one: the guard mounted on /api/* only, with
 * a route above it standing in for the two that authenticate differently
 * (/api/compute, /api/webhooks/*) and must stay reachable.
 */
function app() {
  const a = new Hono();
  a.post("/api/compute/claim", (c) => c.json({ ok: "compute" }));
  a.use("/api/*", crossSiteGuard);
  a.post("/api/ops/garbage/:id/purge", (c) => c.json({ ok: "purged" }));
  a.delete("/api/projects/:id", (c) => c.json({ ok: "deleted" }));
  a.get("/api/leads", (c) => c.json({ ok: "read" }));
  return a;
}

const call = (method, path, headers = {}) =>
  app().request("http://api.aidatasignal.com" + path, { method, headers });

// ---- the attack this exists to stop ------------------------------------

test("a cross-site form POST to a destructive endpoint is refused", async () => {
  // The real attack: no preflight, no body, path-only, cookie attached by the
  // browser. Before the guard this returned 200 and the entity was gone.
  const r = await call("POST", "/api/ops/garbage/ent_x/purge", {
    origin: EVIL,
    "content-type": "application/x-www-form-urlencoded",
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "cross_site_write_blocked");
});

test("a cross-site DELETE is refused", async () => {
  const r = await call("DELETE", "/api/projects/p1", { origin: EVIL });
  assert.equal(r.status, 403);
});

test("Sec-Fetch-Site alone is enough to refuse when Origin is absent", async () => {
  const r = await call("POST", "/api/ops/garbage/ent_x/purge", {
    "sec-fetch-site": "cross-site",
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).sec_fetch_site, "cross-site");
});

// ---- what must keep working --------------------------------------------

test("the dashboard's own writes pass", async () => {
  const r = await call("POST", "/api/ops/garbage/ent_x/purge", { origin: GOOD });
  assert.equal(r.status, 200);
});

test("same-site is allowed — the dashboard is cross-ORIGIN but same-SITE", async () => {
  // aidatasignal.com → api.aidatasignal.com. Rejecting `same-site` here would
  // block every write the dashboard makes.
  const r = await call("POST", "/api/ops/garbage/ent_x/purge", {
    "sec-fetch-site": "same-site",
  });
  assert.equal(r.status, 200);
});

test("same-origin is allowed", async () => {
  const r = await call("POST", "/api/ops/garbage/ent_x/purge", {
    "sec-fetch-site": "same-origin",
  });
  assert.equal(r.status, 200);
});

test("a non-browser client with neither header is allowed", async () => {
  // scripts/provision-cf.mjs, the deploy workflow, external runners. A client
  // that supplies its own credential is not the CSRF threat model, and
  // refusing an ABSENT header would break them while buying nothing: an
  // attacker who can set headers can set Origin too.
  const r = await call("POST", "/api/ops/garbage/ent_x/purge");
  assert.equal(r.status, 200);
});

test("reads are never blocked, even cross-site", async () => {
  // There are no state-changing GET handlers in this worker; blocking reads
  // would only break the dashboard. CORS already stops the attacker reading
  // the response.
  const r = await call("GET", "/api/leads", { origin: EVIL });
  assert.equal(r.status, 200);
});

test("the guard does not reach routes mounted above it", async () => {
  // /api/compute authenticates with a per-node HMAC envelope and is called by
  // non-browsers; /api/webhooks/* likewise. Both mount BEFORE the guard.
  const r = await call("POST", "/api/compute/claim", { origin: EVIL });
  assert.equal(r.status, 200, "compute runners must not be caught by this guard");
});

// ---- the wiring, which the unit tests above cannot see ------------------

test("the guard is mounted after accessGuard and before the route table", () => {
  const src = readFileSync(join(ROOT, "src/index.ts"), "utf8");
  const access = src.search(/api\.use\(\s*"\/api\/\*"\s*,\s*accessGuard\s*\)/);
  const guard = src.search(/api\.use\(\s*"\/api\/\*"\s*,\s*crossSiteGuard\s*\)/);
  const compute = src.search(/api\.route\(\s*"\/api\/compute"/);
  const webhooks = src.search(/api\.route\(\s*"\/api\/webhooks\/campaigns"/);
  assert.ok(guard > -1, "crossSiteGuard is not mounted — every write is unprotected");
  assert.ok(access > -1 && guard > access, "the guard must run after accessGuard");
  assert.ok(compute > -1 && compute < guard, "/api/compute must mount before the guard");
  assert.ok(webhooks > -1 && webhooks < guard, "/api/webhooks/* must mount before the guard");
});

test("CORS and the guard share ONE origin list", () => {
  // Two copies is the one realistic way this guard locks the dashboard out:
  // CORS permits an origin the guard then refuses, and every write 403s.
  const src = readFileSync(join(ROOT, "src/index.ts"), "utf8");
  assert.match(src, /origin:\s*\(origin\)\s*=>\s*\(origin && ALLOWED_ORIGINS\.has\(origin\)/,
    "cors() must read ALLOWED_ORIGINS rather than its own inline list");
  assert.ok(!/const allowed = new Set\(\[\s*"https:\/\/aidatasignal\.com"/.test(src),
    "the inline duplicate of the origin list is back");
  assert.ok(ALLOWED_ORIGINS.has(GOOD) && !ALLOWED_ORIGINS.has(EVIL));
});

test("the guard logs nothing through console (the repo's CI gate forbids it)", () => {
  const src = readFileSync(join(ROOT, "src/middleware/origin.ts"), "utf8");
  assert.ok(!/\bconsole\.(log|warn|error|info|debug)\b/.test(src));
});
