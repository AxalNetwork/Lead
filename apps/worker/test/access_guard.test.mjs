// Task #2 bug-triage: CI assertion that every /api/* route is gated by
// accessGuard, except an explicit documented public allow-list. This is
// a source-introspection test (not a live router invocation) because
// the Worker entrypoint imports Cloudflare-specific bindings at module
// load time. The contract we assert is the ordering of mounts in
// `src/index.ts`: every `api.route("/api/...", ...)` must appear after
// the `api.use("/api/*", accessGuard)` line, except for routes whose
// path is in PUBLIC_ALLOW_LIST below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(__dirname, "../src/index.ts");
const src = readFileSync(indexPath, "utf8");

// Documented public allow-list. Any /api/* route mounted before
// accessGuard must be in this set. Update both this list and the
// docs/bug-triage-2026-05.md checklist together if it changes.
// Per task #2 spec: only `/api/health` and `/api/webhooks/*` are public.
// We list the exact mount paths used in src/index.ts here; the guard test
// matches against this exact-string set, and the prefix `/api/webhooks/`
// is asserted separately below.
const PUBLIC_ALLOW_LIST = new Set([
  "/api/health",
  "/api/webhooks/campaigns",
  // Task #9 (external worker pool): runner endpoints authenticate with a
  // per-node HMAC envelope (src/services/compute/envelope.ts), not the
  // Access JWT, so external (non-browser) runners can reach them. The
  // route itself rejects any request without a valid signature.
  "/api/compute",
]);
const PUBLIC_PREFIX_ALLOW_LIST = ["/api/webhooks/"];

test("accessGuard gates every /api/* route except the documented allow-list", () => {
  const guardMatch = src.match(/api\.use\(\s*"\/api\/\*"\s*,\s*accessGuard\s*\)/);
  assert.ok(guardMatch, "accessGuard mount on /api/* is missing");
  const guardIdx = guardMatch.index;

  const routeRe = /api\.route\(\s*"(\/api\/[^"]*)"/g;
  const beforeGuard = [];
  let m;
  while ((m = routeRe.exec(src))) {
    if (m.index < guardIdx) beforeGuard.push(m[1]);
  }

  const offenders = beforeGuard.filter(
    (p) => !PUBLIC_ALLOW_LIST.has(p) && !PUBLIC_PREFIX_ALLOW_LIST.some((pref) => p.startsWith(pref)),
  );
  assert.deepEqual(
    offenders,
    [],
    `These /api/* routes are mounted before accessGuard and are not in the documented public allow-list: ${offenders.join(", ")}. Add accessGuard above them, or add them to PUBLIC_ALLOW_LIST + the bug-triage checklist.`,
  );

  // Sanity: every entry in the allow-list must actually appear before
  // the guard. Stale allow-list entries are a slow-drift bug.
  for (const p of PUBLIC_ALLOW_LIST) {
    assert.ok(
      beforeGuard.includes(p),
      `PUBLIC_ALLOW_LIST entry ${p} is no longer mounted before accessGuard — remove it from the allow-list.`,
    );
  }
});

test("/health and /api/health are both public per spec", () => {
  // Per task #2 spec, `/api/health` is on the public allow-list (its
  // cheap-liveness twin `/health` is also public). Both must be
  // mounted before the accessGuard line.
  const healthIdx = src.search(/api\.route\(\s*"\/health"/);
  const guardIdx = src.search(/api\.use\(\s*"\/api\/\*"\s*,\s*accessGuard\s*\)/);
  const apiHealthIdx = src.search(/api\.route\(\s*"\/api\/health"/);
  assert.ok(healthIdx > -1, "/health mount missing");
  assert.ok(guardIdx > -1, "accessGuard mount missing");
  assert.ok(apiHealthIdx > -1, "/api/health mount missing");
  assert.ok(healthIdx < guardIdx, "/health must be mounted before accessGuard");
  assert.ok(apiHealthIdx < guardIdx, "/api/health must be mounted before accessGuard (public allow-list per task #2)");
});

test("onError returns a sanitized envelope in production (no Error.stack, no raw internal message)", () => {
  // Source-level assertion: the production branch of onError must
  // build a `{ error: { code, message } }` envelope, never include
  // `cause.stack`, and never pass raw `appErr.message` through for
  // internal/5xx errors.
  const onErr = src.match(/api\.onError\(\([^)]*\)\s*=>\s*\{[\s\S]*?\}\);/);
  assert.ok(onErr, "api.onError block not found");
  const body = onErr[0];
  assert.ok(/error:\s*\{\s*code:/.test(body), "production envelope missing { error: { code, ... } }");
  assert.ok(/safeMessage/.test(body) && /Internal server error/.test(body), "production branch must substitute a sanitized message for internal errors");
  // The production branch must not pass cause.stack in the response.
  const prodBranch = body.match(/if\s*\(\s*isProd\s*\)[\s\S]*?\}\s*\n/);
  assert.ok(prodBranch, "isProd branch not found");
  assert.ok(!/stack/i.test(prodBranch[0]), "production branch must not reference stack");
});
