// Task #51: Surface swallowed errors. Source-shape contract tests (same
// pattern as overrides.test.mjs / preflight.test.mjs): assert the
// previously-silent catches in the fact write path, the scheduled cron
// sub-tasks, and the entity-lock merge path now route through the
// structured error logger (logError → error_log), while preserving the
// non-blocking continue-on-error behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const factsSrc = readFileSync(resolve(__dirname, "../src/entities/facts.ts"), "utf8");
const scheduledSrc = readFileSync(resolve(__dirname, "../src/scheduled.ts"), "utf8");
const entityLockSrc = readFileSync(resolve(__dirname, "../src/do/EntityLock.ts"), "utf8");

// ---------- 1. fact write path ----------
test("facts.ts imports the structured error logger", () => {
  assert.match(factsSrc, /import \{ logError \} from "\.\.\/db\/error_log"/);
});

test("facts.ts override lock-check no longer swallows silently", () => {
  // The pre-insert lock SELECT must log on failure (and still degrade to null).
  assert.match(factsSrc, /override_lock_check[\s\S]{0,120}return null/);
  assert.match(factsSrc, /logError\(env, \{ err: e, step: "facts\.insertFact\.override_lock_check" \}\)/);
});

test("facts.ts override re-check + relInfer enqueue route through logError", () => {
  assert.match(factsSrc, /logError\(env, \{ err: e, step: "facts\.insertFact\.override_recheck" \}\)/);
  assert.match(factsSrc, /logError\(env, \{ err: e, step: "facts\.insertFact\.enqueueRelInfer" \}\)/);
  assert.match(factsSrc, /logError\(env, \{ err: e, step: "facts\.insertFact\.enqueueRelInfer_import" \}\)/);
});

test("facts.ts no longer contains silent .catch(() => undefined) in the write path", () => {
  // The insertFact body (up to the closing of getEffectiveFacts read path) must
  // not reintroduce the silent swallow. We scope to insertFact's source slice.
  const start = factsSrc.indexOf("export async function insertFact");
  const end = factsSrc.indexOf("export interface FactPatch");
  const block = factsSrc.slice(start, end);
  assert.ok(!/\.catch\(\(\)\s*=>\s*undefined\)/.test(block), "insertFact must not swallow with .catch(() => undefined)");
  assert.ok(!/\.catch\(\(\)\s*=>\s*null\)/.test(block), "insertFact must not swallow with .catch(() => null)");
});

// ---------- 2. scheduled cron sub-tasks ----------
test("scheduled.ts imports the structured error logger", () => {
  assert.match(scheduledSrc, /import \{ logError \} from "\.\/db\/error_log"/);
});

test("scheduled.ts hourly monitor + digest fallbacks route through logError", () => {
  for (const step of [
    "hourly.monitor.reevaluateSmartWatchlists",
    "hourly.monitor.monitorEntity",
    "hourly.monitor.retryPendingDeliveries",
    "hourly.digest.runDigest",
  ]) {
    assert.match(scheduledSrc, new RegExp(`logError\\(env, \\{ err: e, step: "${step.replace(/\./g, "\\.")}" \\}\\)`), `missing logError for ${step}`);
  }
});

test("scheduled.ts no longer swallows cron sub-tasks with .catch(() => undefined)", () => {
  assert.ok(!/\.catch\(\(\)\s*=>\s*undefined\)/.test(scheduledSrc), "cron sub-tasks must not swallow with .catch(() => undefined)");
});

// ---------- 3. entity-lock merge path ----------
test("EntityLock.ts imports the structured error logger", () => {
  assert.match(entityLockSrc, /import \{ logError \} from "\.\.\/db\/error_log"/);
});

test("EntityLock.ts merge op handler logs to error_log", () => {
  assert.match(entityLockSrc, /logError\(this\.env, \{ err: e, step: `entityLock\.\$\{op\}` \}\)/);
});

test("EntityLock.ts applyMerge routes DB failure through logError, not a silent console-only swallow", () => {
  assert.match(entityLockSrc, /logError\(env, \{ err: e, step: `entityLock\.applyMerge\.\$\{table\}` \}\)/);
  assert.ok(!/applyMerge \$\{table\} failed/.test(entityLockSrc), "applyMerge must not console-warn-and-swallow the DB error");
});
