// Task #7: regression tests for
//   (1) per-pipeline budget_ms override lookup,
//   (2) sweepStuckJobs writes the step name from the job's last
//       workflow_step_log heartbeat into the error_log row,
//   (3) the deduped DB-error grouper normalizes SQLite messages
//       + routes correctly.

import { test } from "node:test";
import assert from "node:assert/strict";

const { budgetForPipeline, effectiveBudgetMs, DEFAULT_BUDGET_MS, PIPELINE_BUDGETS_MS } =
  await import("../test-dist/queue/pipelineBudgets.js");
const { normalizeDbErrorMessage, routeFromUrl, groupDbErrors } =
  await import("../test-dist/db/dbErrorGrouper.js");
const { sweepStuckJobs } = await import("../test-dist/routes/admin.js");

// ---------- 1. Budget overrides ------------------------------------------
test("budgetForPipeline: unknown kind → null, known kind → ms", () => {
  assert.equal(budgetForPipeline(null), null);
  assert.equal(budgetForPipeline(""), null);
  assert.equal(budgetForPipeline("url"), null); // not in the override map
  assert.equal(budgetForPipeline("firm_team_crawl"), 180_000);
  assert.equal(budgetForPipeline("csv_import"), 240_000);
});

test("effectiveBudgetMs: override only LIFTS — never lowers operator-set budgets", () => {
  // No per-job budget, no override → default.
  assert.equal(effectiveBudgetMs(null, "url"), DEFAULT_BUDGET_MS);
  // No per-job budget, override present → override.
  assert.equal(effectiveBudgetMs(null, "firm_team_crawl"), PIPELINE_BUDGETS_MS.firm_team_crawl);
  // Per-job budget LARGER than override → per-job wins.
  assert.equal(effectiveBudgetMs(300_000, "firm_team_crawl"), 300_000);
  // Per-job budget SMALLER than override → override lifts it.
  assert.equal(effectiveBudgetMs(60_000, "firm_team_crawl"), 180_000);
  // Per-job budget present, no override → per-job.
  assert.equal(effectiveBudgetMs(120_000, "url"), 120_000);
  // Zero / negative jobBudget treated as "unset" so default applies.
  assert.equal(effectiveBudgetMs(0, "url"), DEFAULT_BUDGET_MS);
});

// ---------- 2. Sweeper step attribution -----------------------------------

/**
 * Tiny D1 mock that dispatches `prepare(sql).bind(args).{first,all,run}`
 * to a handler keyed by a substring match on the SQL. Each handler
 * receives the bound args and returns { results } / { first } / { meta }.
 */
function mockDb(handlers) {
  const calls = [];
  function match(sql) {
    for (const key of Object.keys(handlers)) {
      if (sql.indexOf(key) !== -1) return handlers[key];
    }
    return null;
  }
  return {
    calls,
    prepare(sql) {
      const h = match(sql);
      function exec(args, op) {
        calls.push({ sql, args, op });
        if (op === "first") return Promise.resolve(h ? h({ args, op }) : null);
        if (op === "all") return Promise.resolve(h ? h({ args, op }) : { results: [] });
        return Promise.resolve(h ? h({ args, op }) : { meta: { changes: 0 } });
      }
      return {
        // Statements without bound params call .all/.first/.run directly.
        first: () => exec([], "first"),
        all: () => exec([], "all"),
        run: () => exec([], "run"),
        bind(...args) {
          return {
            first: () => exec(args, "first"),
            all: () => exec(args, "all"),
            run: () => exec(args, "run"),
          };
        },
      };
    },
  };
}

test("sweepStuckJobs: writes heartbeat step from workflow_step_log into error_log row", async () => {
  const errorLogInserts = [];
  // jobA: kind=url, budget 90s, started 200s ago → swept
  // jobB: kind=firm_team_crawl, budget 90s, started 150s ago → NOT swept
  //       (override lifts effective budget to 180s)
  const nowIso = new Date().toISOString();
  const startedA = new Date(Date.parse(nowIso) - 200_000).toISOString();
  const startedB = new Date(Date.parse(nowIso) - 150_000).toISOString();
  const db = mockDb({
    // candidate SELECT
    "FROM jobs\n      WHERE status = 'running'": () => ({
      results: [
        { id: "jobA", kind: "url", budget_ms: 90_000, running_started_at: startedA },
        { id: "jobB", kind: "firm_team_crawl", budget_ms: 90_000, running_started_at: startedB },
      ],
    }),
    "UPDATE jobs\n          SET status = 'timed_out'": () => ({ meta: { changes: 1 } }),
    "INSERT INTO job_state_transitions": () => ({ meta: { changes: 1 } }),
    // Heartbeat lookup: still-running step exists for jobA.
    "AND status = 'started'": ({ args }) => {
      if (args[0] === "jobA") return { step: "pipeline:url" };
      return null;
    },
    // Fallback last-row lookup (not hit for jobA because started row exists).
    "FROM workflow_step_log\n            WHERE job_id = ?": () => null,
    // error_log insert — capture the bound args.
    "INSERT INTO error_log": ({ args }) => {
      errorLogInserts.push(args);
      return { meta: { last_row_id: errorLogInserts.length } };
    },
  });
  const env = { DB: db, ANALYTICS: null };
  const swept = await sweepStuckJobs(env);
  assert.equal(swept, 1, "only jobA should be swept; jobB is within lifted budget");
  assert.equal(errorLogInserts.length, 1, "one error_log row per swept job");
  // The error_log INSERT bind order is: request_id, job_id, step, code, …
  // (see src/db/error_log.ts). args[1]=job_id, args[2]=step.
  assert.equal(errorLogInserts[0][1], "jobA");
  assert.equal(errorLogInserts[0][2], "pipeline:url",
    "step field carries the heartbeat step name, not the static admin.sweep sentinel");
});

test("sweepStuckJobs: evaluates legacy null-budget rows against the default (regression)", async () => {
  // Pre-fix the candidate query filtered `budget_ms IS NOT NULL` so legacy
  // null-budget rows were never swept. Lock the inclusive behavior here.
  const errorLogInserts = [];
  const nowIso = new Date().toISOString();
  const startedOld = new Date(Date.parse(nowIso) - 200_000).toISOString(); // 200s > 90s default
  const db = mockDb({
    "FROM jobs\n      WHERE status = 'running'": () => ({
      results: [{ id: "jobNull", kind: "url", budget_ms: null, running_started_at: startedOld }],
    }),
    "UPDATE jobs\n          SET status = 'timed_out'": () => ({ meta: { changes: 1 } }),
    "INSERT INTO job_state_transitions": () => ({ meta: { changes: 1 } }),
    "FROM workflow_step_log": () => null,
    "INSERT INTO error_log": ({ args }) => {
      errorLogInserts.push(args);
      return { meta: { last_row_id: 1 } };
    },
  });
  const env = { DB: db, ANALYTICS: null };
  const swept = await sweepStuckJobs(env);
  assert.equal(swept, 1, "null-budget legacy row past default budget must be swept");
  assert.equal(errorLogInserts.length, 1);
});

test("sweepStuckJobs: falls back to admin.sweep when no heartbeat row exists", async () => {
  const errorLogInserts = [];
  const nowIso = new Date().toISOString();
  const startedA = new Date(Date.parse(nowIso) - 300_000).toISOString();
  const db = mockDb({
    "FROM jobs\n      WHERE status = 'running'": () => ({
      results: [{ id: "jobZ", kind: "url", budget_ms: 90_000, running_started_at: startedA }],
    }),
    "UPDATE jobs\n          SET status = 'timed_out'": () => ({ meta: { changes: 1 } }),
    "INSERT INTO job_state_transitions": () => ({ meta: { changes: 1 } }),
    // Both heartbeat lookups return null (no rows in workflow_step_log).
    "FROM workflow_step_log": () => null,
    "INSERT INTO error_log": ({ args }) => {
      errorLogInserts.push(args);
      return { meta: { last_row_id: 1 } };
    },
  });
  const env = { DB: db, ANALYTICS: null };
  await sweepStuckJobs(env);
  assert.equal(errorLogInserts.length, 1);
  assert.equal(errorLogInserts[0][2], "admin.sweep",
    "step falls back to admin.sweep when no heartbeat row exists");
});

// ---------- 3. DB-error grouper ------------------------------------------

test("normalizeDbErrorMessage: keeps SQLite token + identifier, strips noise", () => {
  assert.equal(
    normalizeDbErrorMessage("D1_ERROR: no such table: social_interactions"),
    "d1_error: no such table: social_interactions",
  );
  // Quoted literals → '…'.
  assert.equal(
    normalizeDbErrorMessage("UNIQUE constraint failed: facts.id with value '42abc'"),
    "unique constraint failed: facts.id with value '…'",
  );
  // UUIDs and long ints stripped.
  const got = normalizeDbErrorMessage("Error at id 12345 row 550e8400-e29b-41d4-a716-446655440000");
  assert.match(got, /<n>/);
  assert.match(got, /<uuid>/);
  // null/empty → "(empty)" — never crash.
  assert.equal(normalizeDbErrorMessage(null), "(empty)");
  assert.equal(normalizeDbErrorMessage(""), "(empty)");
});

test("routeFromUrl: collapses uuid/numeric path segments to :id", () => {
  assert.equal(
    routeFromUrl("https://api.example.com/api/persons/550e8400-e29b-41d4-a716-446655440000/verify"),
    "/api/persons/:id/verify",
  );
  assert.equal(routeFromUrl("/api/jobs/12345"), "/api/jobs/:id");
  assert.equal(routeFromUrl(null), "(unknown)");
  assert.equal(routeFromUrl("/api/foo"), "/api/foo");
});

test("groupDbErrors: groups by (normalized_message, route) and sorts by count desc", () => {
  const rows = [
    { message: "db_error", cause_message: "no such table: foo", url: "/api/a" },
    { message: "db_error", cause_message: "no such table: foo", url: "/api/a" },
    { message: "db_error", cause_message: "no such table: foo", url: "/api/b" },
    { message: "db_error", cause_message: "no such column: bar", url: "/api/a" },
  ];
  const groups = groupDbErrors(rows);
  assert.equal(groups.length, 3, "two distinct routes for same message + one other message");
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].route, "/api/a");
  assert.match(groups[0].normalized_message, /no such table: foo/);
});
