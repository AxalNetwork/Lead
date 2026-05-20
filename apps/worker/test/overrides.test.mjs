// Task #3: Editable Profiles + Manual Overrides with Audit — source-shape
// contract tests. Mirrors the Task #2 people.test.mjs pattern: parse the
// new route/helper source strings and the migration SQL, asserting the
// contract holds (predicates, gating, audit-log writes, lock-check stamp,
// redaction). The Hono entrypoint is not directly invoked (CF bindings
// resolve at module load time — same constraint as access_guard.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..");
const migrationSql = readFileSync(resolve(__dirname, "../migrations/376_field_overrides.sql"), "utf8");
const overridesRouteSrc = readFileSync(resolve(__dirname, "../src/routes/overrides.ts"), "utf8");
const factsSrc = readFileSync(resolve(__dirname, "../src/entities/facts.ts"), "utf8");
const summarySrc = readFileSync(resolve(__dirname, "../src/entities/summary.ts"), "utf8");
const querySrc = readFileSync(resolve(__dirname, "../src/entities/query.ts"), "utf8");
const indexSrc = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
const scheduledSrc = readFileSync(resolve(__dirname, "../src/scheduled.ts"), "utf8");
const fieldEditJs = readFileSync(resolve(root, "site/assets/js/field-edit.js"), "utf8");

// ---------- 1. Migration 376 shape ----------
test("migration 376 creates field_overrides with the spec's columns", () => {
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS field_overrides/);
  for (const col of ["id", "entity_id", "predicate", "value_text", "value_numeric", "value_json", "override_reason", "overridden_by_email", "overridden_at", "locked", "unlock_after", "bulk_operation_id"]) {
    assert.match(migrationSql, new RegExp("\\b" + col + "\\b"), `field_overrides.${col} missing`);
  }
  assert.match(migrationSql, /locked INTEGER NOT NULL DEFAULT 1/);
});

test("migration 376 creates entity_audit_log append-only", () => {
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS entity_audit_log/);
  for (const col of ["id", "entity_id", "action", "actor_email", "payload_json", "created_at"]) {
    assert.match(migrationSql, new RegExp("\\b" + col + "\\b"), `entity_audit_log.${col} missing`);
  }
});

test("migration 376 adds facts.superseded_by_override column + index", () => {
  assert.match(migrationSql, /ALTER TABLE facts ADD COLUMN superseded_by_override INTEGER NOT NULL DEFAULT 0/);
  assert.match(migrationSql, /idx_facts_superseded_by_override/);
});

// ---------- 2. insertFact lock check ----------
test("insertFact checks field_overrides lock before writing", () => {
  assert.match(factsSrc, /Task #3 \(Editable Profiles\): lock check/);
  assert.match(factsSrc, /FROM field_overrides[\s\S]{0,200}AND locked = 1/);
});

test("insertFact stamps superseded_by_override on the new fact row", () => {
  assert.match(factsSrc, /superseded_by_override/);
  // The INSERT must include the new column.
  assert.match(factsSrc, /INSERT INTO facts \([\s\S]+superseded_by_override[\s\S]+\) VALUES/);
});

// ---------- 3. Shared overlay helper ----------
test("getEffectiveFacts overlays overrides over is_current=1 facts", () => {
  assert.match(factsSrc, /export async function getEffectiveFacts/);
  assert.match(factsSrc, /is_override: true/);
  assert.match(factsSrc, /overridden_attempt: true/);
});

test("getEffectiveFacts is the single overlay site for summary + query", () => {
  // Both read sites consume the same shared resolver — no parallel
  // overlay implementations allowed (drift-risk constraint).
  assert.match(summarySrc, /getEffectiveFacts\(/);
  assert.match(querySrc, /getEffectiveFacts\(/);
  // Neither site re-implements the overlay loop.
  assert.doesNotMatch(summarySrc, /overrides\.has\(f\.predicate\)/);
  assert.doesNotMatch(querySrc, /overridesMap\.get\(f\.predicate\)/);
});

// ---------- 4. Read-path overlay ----------
test("summary.ts filters out facts that have an active locked override", () => {
  // getEffectiveFacts returns one row per predicate where overrides
  // win; the summary builder filters overridden_attempt rows out of
  // the summary inputs.
  assert.match(summarySrc, /!e\.overridden_attempt/);
});

test("query.ts exposes overrides and attempts arrays", () => {
  // The split into facts[] / attempts[] is driven by the resolver's
  // overridden_attempt flag.
  assert.match(querySrc, /e\.overridden_attempt/);
  assert.match(querySrc, /attempts/);
  assert.match(querySrc, /overrides: overrideArr/);
});

// ---------- 5. CRUD route shape ----------
test("POST /entities/:id/overrides requires predicate + override_reason", () => {
  assert.match(overridesRouteSrc, /entitiesRoute|overridesRoute/);
  assert.match(overridesRouteSrc, /predicate_required/);
  assert.match(overridesRouteSrc, /override_reason_required/);
});

test("POST /entities/:id/overrides defaults locked=1 and writes audit log", () => {
  assert.match(overridesRouteSrc, /INSERT INTO field_overrides[\s\S]+1\)/);
  assert.match(overridesRouteSrc, /writeAuditLog\([^,]+,[^,]+,\s*"field_override"/);
});

test("POST /entities/:id/overrides stamps existing facts superseded_by_override", () => {
  assert.match(overridesRouteSrc, /UPDATE facts SET superseded_by_override = 1[\s\S]+predicate = \?/);
});

test("POST /entities/:id/overrides/:override_id/unlock flips locked=0 and clears stamp", () => {
  assert.match(overridesRouteSrc, /UPDATE field_overrides SET locked = 0/);
  assert.match(overridesRouteSrc, /UPDATE facts SET superseded_by_override = 0/);
  assert.match(overridesRouteSrc, /"field_unlock"/);
});

// ---------- 6. History API + redaction ----------
test("history endpoint returns overrides + attempts + audit_log", () => {
  assert.match(overridesRouteSrc, /entities\/:id\/overrides\/:predicate\/history/);
  assert.match(overridesRouteSrc, /overrides: overrideRows/);
  assert.match(overridesRouteSrc, /attempts: attempts\.results/);
});

test("non-admin viewers see <redacted> for overridden_by_email", () => {
  assert.match(overridesRouteSrc, /function redactEmail/);
  assert.match(overridesRouteSrc, /"<redacted>"/);
});

// ---------- 7. Bulk override + revert ----------
test("bulk endpoint mints one bulk_operation_id and writes one row per entity", () => {
  assert.match(overridesRouteSrc, /entities\/overrides\/bulk/);
  assert.match(overridesRouteSrc, /const bulkId = crypto\.randomUUID\(\)/);
  assert.match(overridesRouteSrc, /bulk_operation_id/);
});

test("bulk revert flips locked=0 + unlock_after=now without losing history", () => {
  assert.match(overridesRouteSrc, /bulk\/:bulk_operation_id\/revert/);
  assert.match(overridesRouteSrc, /UPDATE field_overrides SET locked = 0, unlock_after = datetime\('now'\)\s+WHERE bulk_operation_id = \?/);
  assert.match(overridesRouteSrc, /"bulk_revert"/);
});

// ---------- 8. Manual entity creation ----------
test("POST /entities routes through createEntity + addRole (no direct INSERT)", () => {
  assert.match(overridesRouteSrc, /await createEntity\(/);
  assert.match(overridesRouteSrc, /await addRole\(/);
  assert.doesNotMatch(overridesRouteSrc.split("function createEntity")[0] || "", /INSERT INTO u_entities/);
});

test("POST /entities supports optional ?fill=ai trigger", () => {
  assert.match(overridesRouteSrc, /c\.req\.query\("fill"\) === "ai"/);
});

// ---------- 9. Soft-delete + merge ----------
test("POST /entities/:id/soft-delete sets status='soft_deleted' + deleted_reason + audit", () => {
  assert.match(overridesRouteSrc, /status = 'soft_deleted', deleted_reason = \?/);
  assert.match(overridesRouteSrc, /"soft_delete"/);
  // Cascade clears entity_roles (consistent with mig 208 trigger).
  assert.match(overridesRouteSrc, /DELETE FROM entity_roles WHERE entity_id = \?/);
});

test("POST /entities/:id/merge-into reuses mergeEntities and writes audit rows", () => {
  assert.match(overridesRouteSrc, /\/entities\/:id\/merge-into/);
  assert.match(overridesRouteSrc, /await mergeEntities\(/);
  assert.match(overridesRouteSrc, /"merge"/);
});

// ---------- 10. Audit log endpoint ----------
test("GET /entities/:id/audit-log redacts actor_email for non-admins", () => {
  assert.match(overridesRouteSrc, /\/entities\/:id\/audit-log/);
  assert.match(overridesRouteSrc, /actor_email: redactEmail\(/);
});

// ---------- 11. Wiring ----------
test("overridesRoute is mounted AFTER accessGuard in src/index.ts", () => {
  const guardIdx = indexSrc.search(/api\.use\(\s*"\/api\/\*"\s*,\s*accessGuard\s*\)/);
  const mountIdx = indexSrc.search(/api\.route\("\/api",\s*overridesRoute\)/);
  assert.ok(guardIdx > -1, "accessGuard mount missing");
  assert.ok(mountIdx > -1, "overridesRoute mount missing");
  assert.ok(mountIdx > guardIdx, "overridesRoute must be mounted after accessGuard");
});

test("nightly unlock_after sweep is wired into the 15 3 * * * cron slot", () => {
  // The import + invocation must live inside the consolidated nightly block.
  const nightly = scheduledSrc.split('cron === "15 3 * * *"')[1] || "";
  assert.match(nightly, /runOverrideUnlockSweep/);
});

// ---------- 12. Static-routing constraint (UI deep links) ----------
test("UI helper uses ?id= query strings, never /:id segments", () => {
  // Encoded entity_id with `?id=` is the only deep-link form.
  assert.match(fieldEditJs, /\?id=/);
  // No /dashboard/people/<id>/ style path segment.
  assert.doesNotMatch(fieldEditJs, /\/dashboard\/people\/\$\{?[^?]*\}?\//);
});

// ---------- 13. Acceptance scenario (Jim Murphy) — logical assertions ----------
test("acceptance: override row beats subsequent AI fact at read time", () => {
  // 1. POST override row is inserted with locked=1.
  assert.match(overridesRouteSrc, /INSERT INTO field_overrides[\s\S]+VALUES[\s\S]+1\)/);
  // 2. insertFact stamps the next AI write as superseded_by_override.
  assert.match(factsSrc, /superseded_by_override/);
  // 3. summary + query overlays return the override value as canonical
  // (via the shared getEffectiveFacts resolver — exactly one overlay
  // implementation, consumed by both read sites).
  assert.match(summarySrc, /getEffectiveFacts\(/);
  assert.match(querySrc, /getEffectiveFacts\(/);
  // 4. History endpoint exposes the AI attempt with superseded_by_override.
  assert.match(overridesRouteSrc, /attempts: attempts\.results/);
});
