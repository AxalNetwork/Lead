// Pure access-control matrix tests for the intro routes. Validates
// the decision helpers extracted from routes/intros.ts so the access
// matrix is independent of D1/Hono plumbing.
//
// Matrix under test:
//   POST /api/intros/:path_id/log-outcome ownership:
//     - owner               → allowed
//     - admin (non-owner)   → allowed (override)
//     - other operator      → 403
//     - anonymous           → 403
//
//   GET /api/intros/by-target/:id scoping:
//     - admin     → returns scope=admin, projects viewer_email
//     - non-admin → returns scope=owner, suppresses viewer_email,
//                   filters rows by caller's email

import { test } from "node:test";
import assert from "node:assert/strict";

const a = await import("../../../../test-dist/services/intros/authz.js");

test("decideOutcomeAccess: owner is allowed", () => {
  const d = a.decideOutcomeAccess("alice@example.com", "alice@example.com", false);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "owner");
});

test("decideOutcomeAccess: case-insensitive owner match", () => {
  const d = a.decideOutcomeAccess("ALICE@Example.com", "alice@example.com", false);
  assert.equal(d.allowed, true);
});

test("decideOutcomeAccess: admin overrides non-owner", () => {
  const d = a.decideOutcomeAccess("ops@example.com", "alice@example.com", true);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "admin");
});

test("decideOutcomeAccess: non-owner non-admin is rejected", () => {
  const d = a.decideOutcomeAccess("bob@example.com", "alice@example.com", false);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "not_owner");
});

test("decideOutcomeAccess: anonymous caller is rejected", () => {
  const d = a.decideOutcomeAccess(null, "alice@example.com", false);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "no_caller");
});

test("decideOutcomeAccess: null owner + non-admin caller is rejected", () => {
  // Defensive: a path with no recorded owner cannot be claimed by
  // an arbitrary caller as their own.
  const d = a.decideOutcomeAccess("bob@example.com", null, false);
  assert.equal(d.allowed, false);
});

test("decideOutcomeAccess: admin allowed even with null owner", () => {
  const d = a.decideOutcomeAccess("ops@example.com", null, true);
  assert.equal(d.allowed, true);
});

test("decideByTargetScope: admin sees all + projects viewer_email", () => {
  const s = a.decideByTargetScope("ops@example.com", true);
  assert.equal(s.scope, "admin");
  assert.equal(s.project_viewer_email, true);
  assert.equal(s.filter_owner_email, null);
});

test("decideByTargetScope: non-admin → owner scope, viewer_email suppressed, filter set", () => {
  const s = a.decideByTargetScope("alice@example.com", false);
  assert.equal(s.scope, "owner");
  assert.equal(s.project_viewer_email, false);
  assert.equal(s.filter_owner_email, "alice@example.com");
});

test("decideByTargetScope: anonymous non-admin → empty filter", () => {
  const s = a.decideByTargetScope(null, false);
  assert.equal(s.scope, "owner");
  assert.equal(s.filter_owner_email, null);
});
