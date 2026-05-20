// Task #5: collector unit tests. Pure-JS — D1 mocked via a tiny
// statement recorder. Covers cold-install regression (every collector
// must return a sane empty result when source tables are absent) and
// the node-status / queue-aging logic.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  collectComputePool,
  collectQueues,
  collectD1,
  collectRecentErrors,
  collectErrorRatePerMin,
  collectCronStatus,
  collectExternalApis,
  collectR2,
  collectKV,
  collectVectorize,
  nodeStatus,
  safeQuery,
} = await import("../../../../test-dist/services/systemHealth/collectors.js");

// ---------- mock DB --------------------------------------------------------

function throwingDb() {
  return {
    prepare() {
      throw new Error("no such table");
    },
  };
}

function fixtureDb(handlers) {
  // handlers: {match(sql) => row(s)}
  return {
    prepare(sql) {
      const stmt = {
        _sql: sql,
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          for (const h of handlers) {
            if (h.test(sql, stmt._args)) {
              const v = typeof h.first === "function" ? h.first(stmt._args) : h.first;
              return v ?? null;
            }
          }
          return null;
        },
        async all() {
          for (const h of handlers) {
            if (h.test(sql, stmt._args)) {
              const v = typeof h.all === "function" ? h.all(stmt._args) : h.all;
              return { results: v ?? [] };
            }
          }
          return { results: [] };
        },
        async run() { return { meta: { changes: 0 } }; },
      };
      return stmt;
    },
  };
}

// ---------- safeQuery ------------------------------------------------------

test("safeQuery: returns empty on throw", async () => {
  const r = await safeQuery(async () => { throw new Error("missing"); }, []);
  assert.deepEqual(r, []);
});

test("safeQuery: passes through success", async () => {
  const r = await safeQuery(async () => [1, 2, 3], []);
  assert.deepEqual(r, [1, 2, 3]);
});

// ---------- cold-install regression ----------------------------------------

test("cold install: collectComputePool returns []", async () => {
  const r = await collectComputePool({ DB: throwingDb() });
  assert.deepEqual(r, []);
});

test("cold install: collectQueues returns 4 zero-depth cards", async () => {
  const r = await collectQueues({ DB: throwingDb() });
  assert.equal(r.length, 4);
  for (const q of r) {
    assert.equal(q.depth, 0);
    assert.equal(q.oldest_age_seconds, null);
    assert.deepEqual(q.sparkline, []);
  }
});

test("cold install: collectD1 returns zeros", async () => {
  const r = await collectD1({ DB: throwingDb() });
  assert.equal(r.errors_24h, 0);
  assert.equal(r.throttled_24h, 0);
});

test("cold install: collectRecentErrors returns []", async () => {
  const r = await collectRecentErrors({ DB: throwingDb() });
  assert.deepEqual(r, []);
});

test("cold install: collectErrorRatePerMin returns 0", async () => {
  const r = await collectErrorRatePerMin({ DB: throwingDb() });
  assert.equal(r, 0);
});

test("cold install: collectCronStatus returns rows w/ null last_run", async () => {
  const r = await collectCronStatus({ DB: throwingDb() });
  assert.ok(r.length >= 2);
  for (const c of r) assert.equal(c.last_run, null);
});

test("cold install: collectExternalApis returns one card per name w/ null fields", async () => {
  const r = await collectExternalApis({ DB: throwingDb() }, ["sec_edgar", "fec"]);
  assert.equal(r.length, 2);
  assert.equal(r[0].last_success, null);
  assert.equal(r[0].success_rate_24h, null);
});

test("cold install: binding collectors do not throw on empty env", () => {
  assert.ok(Array.isArray(collectR2({})));
  assert.ok(Array.isArray(collectKV({})));
  assert.ok(Array.isArray(collectVectorize({})));
});

// ---------- nodeStatus logic ----------------------------------------------

test("nodeStatus: drained > all", () => {
  assert.equal(nodeStatus({ enabled: 1, drain: 1, last_heartbeat_at: new Date().toISOString(), last_error: null }), "drained");
});

test("nodeStatus: disabled is red", () => {
  assert.equal(nodeStatus({ enabled: 0, drain: 0, last_heartbeat_at: new Date().toISOString(), last_error: null }), "red");
});

test("nodeStatus: no heartbeat is yellow", () => {
  assert.equal(nodeStatus({ enabled: 1, drain: 0, last_heartbeat_at: null, last_error: null }), "yellow");
});

test("nodeStatus: stale heartbeat (>5min) is red", () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  assert.equal(nodeStatus({ enabled: 1, drain: 0, last_heartbeat_at: old, last_error: null }), "red");
});

test("nodeStatus: recent + last_error is yellow", () => {
  const recent = new Date(Date.now() - 30_000).toISOString();
  assert.equal(nodeStatus({ enabled: 1, drain: 0, last_heartbeat_at: recent, last_error: "boom" }), "yellow");
});

test("nodeStatus: recent + clean is green", () => {
  const recent = new Date(Date.now() - 30_000).toISOString();
  assert.equal(nodeStatus({ enabled: 1, drain: 0, last_heartbeat_at: recent, last_error: null }), "green");
});

// ---------- queue aging ----------------------------------------------------

test("collectQueues: computes oldest_age_seconds from MIN(created_at)", async () => {
  const oldIso = new Date(Date.now() - 3600 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const db = fixtureDb([
    { test: (s) => /FROM jobs/.test(s),
      first: () => ({ depth: 3, oldest: oldIso, failed_24h: 1 }) },
    { test: (s) => /FROM csv_imports/.test(s), first: () => ({ depth: 0, oldest: null }) },
    { test: (s) => /FROM crawl_frontier/.test(s), first: () => ({ depth: 0, oldest: null }) },
    { test: (s) => /FROM smart_frontier/.test(s), first: () => ({ depth: 0, oldest: null }) },
    { test: (s) => /FROM health_snapshots/.test(s), all: () => [] },
  ]);
  const r = await collectQueues({ DB: db });
  const jobs = r.find((q) => q.queue_name === "aidatasignal-lead-jobs");
  assert.ok(jobs);
  assert.equal(jobs.depth, 3);
  assert.ok(jobs.oldest_age_seconds >= 3500 && jobs.oldest_age_seconds <= 3700, `age=${jobs.oldest_age_seconds}`);
  assert.equal(jobs.failed_24h, 1);
});

// ---------- error signature grouping ---------------------------------------

test("collectRecentErrors: groups by (code, normalized message), counts, picks max last_seen", async () => {
  const rows = [
    { code: "db_error", kind: "x", route: "/api/a", message: "no such column 'foo' at line 12", created_at: "2026-05-20T10:00:00Z" },
    { code: "db_error", kind: "x", route: "/api/a", message: "no such column 'foo' at line 99", created_at: "2026-05-20T10:05:00Z" },
    { code: "http_500", kind: "x", route: "/api/b", message: "boom", created_at: "2026-05-20T09:00:00Z" },
  ];
  const db = fixtureDb([{ test: (s) => /FROM error_log/.test(s), all: () => rows }]);
  const r = await collectRecentErrors({ DB: db });
  assert.equal(r.length, 2);
  const dbErr = r.find((x) => x.sample_code === "db_error");
  assert.equal(dbErr.count, 2);
  assert.equal(dbErr.last_seen, "2026-05-20T10:05:00Z");
});
