// Task #72: robots.txt / ToS blocks are benign SKIPS, not crawler errors.
//
// A profile-scrape job blocked by robots_disallow (or tos_blocked) must end in
// the benign `skipped` terminal status, write NO error_log row (so it stops
// surfacing as a red 422 in the operator console), and never retry — while
// genuine transient failures still retry and genuine permanent failures still
// dead-letter.
//
// The classify/isBenignSkip predicate is covered behaviorally in
// errors_classify.test.mjs. Here we cover:
//   1. timedStep (the executor seam that actually writes error_log) suppresses
//      the error_log row for benign skips and logs a `skipped` step instead,
//      while still logging genuine errors — proven behaviorally via a mock D1.
//   2. The pipeline executor catch + queue handler route benign skips to
//      markSkipped (no logError, no retry) — proven via source inspection
//      (same pattern as preflight.test.mjs #6, because pipeline.ts/index.ts are
//      not in the test build's include allow-list and can't be imported here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { timedStep } = await import("../test-dist/db/error_log.js");

function mockDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { changes: 1, last_row_id: 1 } }),
          };
        },
      };
    },
  };
}

const errorLogInserts = (db) => db.calls.filter((c) => c.sql.includes("INSERT INTO error_log"));
const stepInserts = (db) => db.calls.filter((c) => c.sql.includes("INSERT INTO workflow_step_log"));
// workflow_step_log bind order: job_id, step, step_name, status, ...
const stepStatus = (call) => call.args[3];

// ---- 1. timedStep suppresses error_log for benign skips --------------------
test("timedStep: robots_disallow block writes NO error_log and logs a skipped step", async () => {
  const db = mockDb();
  await assert.rejects(
    timedStep({ DB: db }, "job-1", "pipeline:profile_list", async () => {
      throw new Error("fetch_failed:robots_disallow:status=0");
    }),
    /robots_disallow/,
  );
  assert.equal(errorLogInserts(db).length, 0, "benign robots block must NOT write error_log");
  const steps = stepInserts(db).map(stepStatus);
  assert.ok(steps.includes("skipped"), "must record a `skipped` step, not an `error` step");
  assert.ok(!steps.includes("error"), "must not record an `error` step for a benign skip");
});

test("timedStep: tos_blocked block writes NO error_log and logs a skipped step", async () => {
  const db = mockDb();
  await assert.rejects(
    timedStep({ DB: db }, "job-2", "pipeline:profile_list", async () => {
      throw new Error("fetch_failed:tos_blocked:tiktok.com:status=0");
    }),
    /tos_blocked/,
  );
  assert.equal(errorLogInserts(db).length, 0, "benign ToS block must NOT write error_log");
  assert.ok(stepInserts(db).map(stepStatus).includes("skipped"));
});

// ---- 2. genuine failures still write error_log (regression guard) ----------
test("timedStep: genuine permanent (403) STILL writes error_log + error step", async () => {
  const db = mockDb();
  await assert.rejects(
    timedStep({ DB: db }, "job-3", "pipeline:profile_list", async () => {
      throw new Error("fetch_failed:status_403:status=403");
    }),
    /status_403/,
  );
  assert.equal(errorLogInserts(db).length, 1, "a real 403 block must still write error_log");
  assert.ok(stepInserts(db).map(stepStatus).includes("error"));
});

test("timedStep: genuine transient (429) STILL writes error_log (retried at queue)", async () => {
  const db = mockDb();
  await assert.rejects(
    timedStep({ DB: db }, "job-4", "pipeline:profile_list", async () => {
      throw new Error("fetch_failed:status_429:status=429");
    }),
    /status_429/,
  );
  assert.equal(errorLogInserts(db).length, 1, "a real rate-limit must still write error_log");
});

// ---- 3. routing seams (source inspection) ----------------------------------
test("source: pipeline executor catch routes benign skips to markSkipped", () => {
  const src = readFileSync(resolve(__dirname, "../src/scraper/pipeline.ts"), "utf8");
  // The final executor catch (previously markFailed-only) must branch on
  // isBenignSkip → markSkipped, else markFailed.
  assert.match(src, /const skip = isBenignSkip\(e\)/);
  assert.match(src, /markSkipped\(env, jobId, skip\.skip_code, skip\.reason/);
  assert.match(src, /export async function markSkipped/);
});

test("source: queue handler skips benign blocks without error_log or retry", () => {
  const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
  const i = src.indexOf("const benignSkip = isBenignSkip(appErr)");
  assert.ok(i > 0, "queue handler must detect benign skips");
  // Bound the benign-skip block to the start of the normal error path that
  // follows it (search from `i` so we don't match an earlier logError call).
  const block = src.slice(i, src.indexOf("await logError(env, { err: appErr", i));
  assert.match(block, /markSkipped\(env, jobId, benignSkip\.skip_code, benignSkip\.reason/);
  assert.match(block, /msg\.ack\(\)/);
  assert.match(block, /continue;/);
  assert.ok(!/logError\(/.test(block), "benign-skip branch must not write error_log");
  assert.ok(!/msg\.retry\(/.test(block), "benign-skip branch must not retry");
});
