// Task #52: Durable Object merge consistency. Source-shape contract tests
// (same pattern as error_surfacing.test.mjs): assert that the EntityLock
// merge path runs its post-D1 secondary-store updates (Vectorize + AI
// Search) guarded, logs failures, and records a DURABLE reconcile flag with
// a retry alarm — so D1 is never left silently out of sync. Also assert the
// vector upsert now SIGNALS failure (boolean) so a swallowed upsert is
// observable rather than silent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const lockSrc = readFileSync(resolve(__dirname, "../src/do/EntityLock.ts"), "utf8");
const vectorSrc = readFileSync(resolve(__dirname, "../src/dedupe/vector.ts"), "utf8");
const searchSrc = readFileSync(resolve(__dirname, "../src/ai/search_sync.ts"), "utf8");

// ---------- 1. vector store signals failure instead of swallowing it ----------
test("upsertEntityVector returns a boolean so a rejected upsert is observable", () => {
  // Signature now resolves to boolean, not void.
  assert.match(vectorSrc, /export async function upsertEntityVector\([\s\S]*?\): Promise<boolean>/);
  // The catch path returns false (divergence signal) rather than silently void.
  assert.match(vectorSrc, /catch \(e\) \{[\s\S]{0,160}return false;/);
  // The happy path returns true after the upsert.
  assert.match(vectorSrc, /trackVectorize\(env, \{ op: "upsert", index: kind \}\);\s*\n\s*return true;/);
});

// ---------- 2. secondary updates are guarded + logged ----------
test("EntityLock routes secondary-store writes through a guarded syncSecondary", () => {
  assert.match(lockSrc, /private async syncSecondary\(/);
  // Vector failure (either a thrown error OR a false return) is logged + flagged.
  assert.match(lockSrc, /step: `entityLock\.sync\.vector\.\$\{kind\}`/);
  assert.match(lockSrc, /step: `entityLock\.sync\.search\.\$\{kind\}`/);
  // A false return from upsertEntityVector is treated as a divergence.
  assert.match(lockSrc, /if \(!ok\) \{[\s\S]{0,200}failed\.push\("vector"\)/);
  // A false return from indexEntity (live AI Search write failed) is likewise
  // logged + flagged, not just a thrown error.
  assert.match(lockSrc, /const ok = await indexEntity\(this\.env, sync\.search\);[\s\S]{0,220}failed\.push\("search"\)/);
});

test("indexEntity signals failure via boolean so search divergence is observable", () => {
  assert.match(searchSrc, /export async function indexEntity\([\s\S]*?\): Promise<boolean>/);
});

test("every merge result carries reconcile_pending (no silent success)", () => {
  // The merge return type exposes the divergent stores.
  assert.match(lockSrc, /reconcile_pending: SecondaryStore\[\]/);
  // Each merge path threads the syncSecondary result into the response.
  const mergeReturns = lockSrc.match(/return \{ ok: true, id: body\.id, updated, reconcile_pending[^}]*\}/g) ?? [];
  // lead, firm, company, account, buyer = 5 merge methods.
  assert.ok(mergeReturns.length >= 5, `expected >=5 merge returns with reconcile_pending, got ${mergeReturns.length}`);
});

// ---------- 3. failures are flagged durably + retried (recoverable) ----------
test("EntityLock persists a reconcile flag to DO storage and schedules an alarm", () => {
  assert.match(lockSrc, /private async flagReconcile\(/);
  assert.match(lockSrc, /this\.state\.storage\.put\(key, rec\)/);
  // Only arm a fresh alarm when none is pending.
  assert.match(lockSrc, /getAlarm\(\)[\s\S]{0,120}setAlarm\(Date\.now\(\) \+ RECONCILE_DELAY_MS\)/);
  // The stored record carries the payload needed to retry without re-reading D1.
  assert.match(lockSrc, /interface ReconcileRecord \{[\s\S]*?sync: SecondarySync;[\s\S]*?\}/);
});

test("alarm() retries pending reconciles, clears on success, gives up after a cap", () => {
  assert.match(lockSrc, /async alarm\(\): Promise<void>/);
  assert.match(lockSrc, /this\.state\.storage\.list<ReconcileRecord>\(\{ prefix: RECONCILE_PREFIX \}\)/);
  // Cleared on success.
  assert.match(lockSrc, /if \(!stillFailed\.length\) \{[\s\S]{0,80}delete\(key\)/);
  // Exhaustion is logged (permanent divergence stays visible) then dropped.
  assert.match(lockSrc, /attempts >= MAX_RECONCILE_ATTEMPTS/);
  assert.match(lockSrc, /step: `entityLock\.reconcile\.exhausted\.\$\{rec\.kind\}`/);
  // Remaining work re-arms the alarm.
  assert.match(lockSrc, /if \(remaining\) await this\.state\.storage\.setAlarm/);
});

test("reconcile retry budget is bounded by a constant", () => {
  assert.match(lockSrc, /const MAX_RECONCILE_ATTEMPTS = \d+;/);
  assert.match(lockSrc, /const RECONCILE_DELAY_MS = \d+/);
});
