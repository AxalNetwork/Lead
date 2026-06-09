// Task #69: regression tests for the job state-machine on queue retries.
//
// The bug: Cloudflare Queues redelivers a failed/timed_out message, but
// `markRunning` only re-entered `running` from `queued`, so the row stayed
// `failed`/`timed_out`. `markCompleted` then ran an UNGUARDED
// `UPDATE ... SET status='succeeded'`, attempting an illegal
// failed/timed_out -> succeeded transition that trips the migration-193
// trigger (RAISE(ABORT,'invalid_state_transition')) — surfaced as a
// retryable 503 that loops forever.
//
// These tests exercise the REAL state-machine trigger
// (`trg_jobs_status_transition`, read verbatim from the migration SQL)
// against the ACTUAL markRunning/markCompleted SQL strings (read verbatim
// from src/scraper/pipeline.ts). pipeline.ts itself can't be imported in
// the test build (it loads the full CF dep tree at module load and isn't
// in tsconfig.test.json's include allow-list), so we lift its exact SQL
// out of source and run it against an in-memory node:sqlite DB carrying
// the real trigger. This proves both that the guards are present in source
// AND that they produce only legal transitions under the live trigger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pipelineSrc = readFileSync(
  fileURLToPath(new URL("../src/scraper/pipeline.ts", import.meta.url)),
  "utf8",
);
const migration372 = readFileSync(
  fileURLToPath(new URL("../migrations/372_jobs_skipped_status.sql", import.meta.url)),
  "utf8",
);

// ---- Extract the REAL SQL from source --------------------------------------

// markRunning's UPDATE (double-quoted string literal).
const markRunningSql = (() => {
  const m = pipelineSrc.match(/"(UPDATE jobs SET status = 'running', running_started_at = \? WHERE id = \?[^"]*)"/);
  assert.ok(m, "could not find markRunning UPDATE in pipeline.ts");
  return m[1];
})();

// markCompleted's UPDATE (backtick template literal). Take the first match
// (the markCompleted body); it must end with the new status guard.
const markCompletedSql = (() => {
  const m = pipelineSrc.match(/`(UPDATE jobs SET status = 'succeeded'[^`]*)`/);
  assert.ok(m, "could not find markCompleted UPDATE in pipeline.ts");
  return m[1];
})();

// The real transition trigger, lifted verbatim from migration 372.
const triggerDdl = (() => {
  const start = migration372.indexOf("CREATE TRIGGER trg_jobs_status_transition");
  assert.ok(start > 0, "trg_jobs_status_transition not found in migration 372");
  const end = migration372.indexOf("END;", start);
  assert.ok(end > 0, "could not find END; of trg_jobs_status_transition");
  return migration372.slice(start, end + "END;".length);
})();

// ---- Source-contract guards (cheap, fail-fast) -----------------------------

test("markRunning SQL re-enters running from queued/failed/timed_out", () => {
  assert.match(markRunningSql, /status IN \('queued','failed','timed_out'\)/,
    "markRunning must allow re-entry from queued/failed/timed_out");
  assert.doesNotMatch(markRunningSql, /status IN \([^)]*'succeeded'/);
  assert.doesNotMatch(markRunningSql, /status IN \([^)]*'cancelled'/);
  assert.doesNotMatch(markRunningSql, /status IN \([^)]*'dead_letter'/);
});

test("markCompleted SQL guards on status = 'running'", () => {
  assert.match(markCompletedSql, /WHERE id = \? AND status = 'running'/,
    "markCompleted must only flip a row that is actually running");
});

// ---- Live-trigger behavioral tests -----------------------------------------

function freshDb() {
  const db = new DatabaseSync(":memory:");
  // Minimal jobs schema: the columns the trigger + the two UPDATEs touch.
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      running_started_at TEXT,
      finished_at TEXT,
      error TEXT,
      leads_found INTEGER,
      pages_fetched INTEGER,
      pages_blocked INTEGER,
      captcha_hits INTEGER,
      cost_ms INTEGER,
      result_json TEXT
    );
  `);
  db.exec(triggerDdl);
  return db;
}

// markFailed / timed_out transitions used to set up the retry scenarios.
// These are legal running-> edges in the same trigger graph.
function setStatus(db, id, status) {
  db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
}

function runMarkRunning(db, id) {
  return db.prepare(markRunningSql).run(new Date().toISOString(), id);
}
function runMarkCompleted(db, id) {
  return db.prepare(markCompletedSql).run(
    new Date().toISOString(), 0, 0, 0, 0, 0, "{}", id,
  );
}
function statusOf(db, id) {
  return db.prepare("SELECT status FROM jobs WHERE id = ?").get(id).status;
}

test("retried job (failed -> redeliver -> running -> succeeded) ends succeeded, no throw", () => {
  const db = freshDb();
  db.prepare("INSERT INTO jobs (id, status) VALUES ('j1','queued')").run();
  runMarkRunning(db, "j1");
  assert.equal(statusOf(db, "j1"), "running");
  // prior attempt fails (running -> failed is legal)
  setStatus(db, "j1", "failed");
  // Cloudflare Queues redelivers -> markRunning re-enters running.
  const reran = runMarkRunning(db, "j1");
  assert.equal(reran.changes, 1, "markRunning must re-enter running from failed");
  assert.equal(statusOf(db, "j1"), "running");
  // succeeds on retry — must NOT trip invalid_state_transition.
  assert.doesNotThrow(() => runMarkCompleted(db, "j1"));
  assert.equal(statusOf(db, "j1"), "succeeded");
  db.close();
});

test("retried job (timed_out -> redeliver -> running -> succeeded) ends succeeded, no throw", () => {
  const db = freshDb();
  db.prepare("INSERT INTO jobs (id, status) VALUES ('j2','queued')").run();
  runMarkRunning(db, "j2");
  setStatus(db, "j2", "timed_out"); // running -> timed_out (legal)
  const reran = runMarkRunning(db, "j2");
  assert.equal(reran.changes, 1, "markRunning must re-enter running from timed_out");
  assert.doesNotThrow(() => runMarkCompleted(db, "j2"));
  assert.equal(statusOf(db, "j2"), "succeeded");
  db.close();
});

test("markCompleted is a safe no-op against a terminal cancelled row", () => {
  const db = freshDb();
  db.prepare("INSERT INTO jobs (id, status) VALUES ('j3','queued')").run();
  setStatus(db, "j3", "cancelled"); // queued -> cancelled (legal)
  let res;
  assert.doesNotThrow(() => { res = runMarkCompleted(db, "j3"); });
  assert.equal(res.changes, 0, "no row should flip — guard excludes non-running");
  assert.equal(statusOf(db, "j3"), "cancelled", "terminal state must be preserved");
  db.close();
});

test("markCompleted is a safe no-op against a terminal timed_out row (the bug)", () => {
  const db = freshDb();
  db.prepare("INSERT INTO jobs (id, status) VALUES ('j4','queued')").run();
  runMarkRunning(db, "j4");
  setStatus(db, "j4", "timed_out");
  // Pre-fix this UPDATE attempted timed_out -> succeeded and threw.
  let res;
  assert.doesNotThrow(() => { res = runMarkCompleted(db, "j4"); });
  assert.equal(res.changes, 0);
  assert.equal(statusOf(db, "j4"), "timed_out");
  db.close();
});

test("markRunning never resurrects a truly terminal state (succeeded/cancelled)", () => {
  const db = freshDb();
  db.prepare("INSERT INTO jobs (id, status) VALUES ('j5','queued')").run();
  runMarkRunning(db, "j5");
  setStatus(db, "j5", "running"); // already running
  runMarkCompleted(db, "j5");      // -> succeeded
  assert.equal(statusOf(db, "j5"), "succeeded");
  const reran = runMarkRunning(db, "j5");
  assert.equal(reran.changes, 0, "succeeded must not be reopened");
  assert.equal(statusOf(db, "j5"), "succeeded");

  db.prepare("INSERT INTO jobs (id, status) VALUES ('j6','queued')").run();
  setStatus(db, "j6", "cancelled");
  const reran2 = runMarkRunning(db, "j6");
  assert.equal(reran2.changes, 0, "cancelled must not be reopened");
  assert.equal(statusOf(db, "j6"), "cancelled");
  db.close();
});

test("the trigger is real: an UNGUARDED succeeded-from-failed UPDATE throws invalid_state_transition", () => {
  // Proves the tests above pass because of the guards, not because the
  // trigger is inert. The pre-fix markCompleted SQL had no status guard.
  const db = freshDb();
  db.prepare("INSERT INTO jobs (id, status) VALUES ('j7','queued')").run();
  runMarkRunning(db, "j7");
  setStatus(db, "j7", "failed");
  assert.throws(
    () => db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run("j7"),
    /invalid_state_transition/,
  );
  db.close();
});
