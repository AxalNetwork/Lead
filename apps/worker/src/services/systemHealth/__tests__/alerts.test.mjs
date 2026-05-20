// Task #5: alert evaluator semantics. Mocks collectors via the
// stateful DB recorder so we can exercise open / close / dedupe.

import { test } from "node:test";
import assert from "node:assert/strict";

const { evaluateBreaches, runAlertEvaluator, THRESHOLDS } = await import(
  "../../../../test-dist/services/systemHealth/alerts.js"
);

// ---------- mocks ----------------------------------------------------------

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

function makeDb(state) {
  // state: { incidents: [], jobs: {depth, oldest, failed_24h},
  //          nodes: [], err_per_min: 0, throttled_24h: 0 }
  return {
    _inserted: [],
    _updated: [],
    prepare(sql) {
      const self = this;
      const stmt = {
        _sql: sql,
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          if (/FROM jobs/.test(sql)) return state.jobs ?? { depth: 0, oldest: null, failed_24h: 0 };
          if (/FROM csv_imports/.test(sql)) return { depth: 0, oldest: null };
          if (/FROM crawl_frontier/.test(sql)) return { depth: 0, oldest: null };
          if (/FROM smart_frontier/.test(sql)) return { depth: 0, oldest: null };
          if (/FROM error_log[\s\S]*1 minute/.test(sql)) return { n: state.err_per_min ?? 0 };
          if (/FROM error_log/.test(sql)) return { errors: state.errors_24h ?? 0, throttled: state.throttled_24h ?? 0 };
          if (/FROM workflow_step_log/.test(sql)) return { n: 0 };
          if (/FROM ops_incidents WHERE signature/.test(sql)) {
            const sig = stmt._args[0];
            return state.incidents.find((i) => i.signature === sig && !i.closed_at) ?? null;
          }
          return null;
        },
        async all() {
          if (/FROM compute_nodes/.test(sql)) return { results: state.nodes ?? [] };
          if (/FROM compute_job_assignments/.test(sql)) return { results: [] };
          if (/FROM ops_incidents WHERE closed_at IS NULL/.test(sql)) {
            return { results: state.incidents.filter((i) => !i.closed_at) };
          }
          if (/FROM health_snapshots/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async run() {
          if (/INSERT (OR IGNORE )?INTO ops_incidents/.test(sql)) {
            const [id, severity, kind, signature, summary, context_json, delivery_status] = stmt._args;
            state.incidents.push({ id, severity, kind, signature, summary, context_json, delivery_status, closed_at: null });
            self._inserted.push({ table: "ops_incidents", id, signature });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE ops_incidents/.test(sql) && /closed_at = datetime\('now'\)/.test(sql)) {
            const id = stmt._args[0];
            const inc = state.incidents.find((i) => i.id === id);
            if (inc) inc.closed_at = new Date().toISOString();
            self._updated.push({ table: "ops_incidents", id, closed: true });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
}

// ---------- evaluateBreaches ----------------------------------------------

test("evaluateBreaches: queue_age fires past threshold", async () => {
  const env = {
    DB: makeDb({
      incidents: [],
      jobs: { depth: 5, oldest: new Date(Date.now() - 35 * 60_000).toISOString(), failed_24h: 0 },
      nodes: [],
      err_per_min: 0,
      throttled_24h: 0,
    }),
    SESSIONS: makeKv(),
  };
  const b = await evaluateBreaches(env);
  const queueB = b.filter((x) => x.kind === "queue_age");
  assert.equal(queueB.length, 1);
  assert.equal(queueB[0].signature, "queue_age:aidatasignal-lead-jobs");
});

test("evaluateBreaches: queue_age does NOT fire below threshold", async () => {
  const env = {
    DB: makeDb({
      incidents: [],
      jobs: { depth: 5, oldest: new Date(Date.now() - 5 * 60_000).toISOString(), failed_24h: 0 },
      nodes: [],
    }),
    SESSIONS: makeKv(),
  };
  const b = await evaluateBreaches(env);
  assert.equal(b.filter((x) => x.kind === "queue_age").length, 0);
});

test("evaluateBreaches: node_down does NOT fire for disabled node (admin-parked)", async () => {
  const env = {
    DB: makeDb({
      incidents: [],
      jobs: { depth: 0, oldest: null, failed_24h: 0 },
      nodes: [{
        id: "n_off", name: "Parked", provider: "p", kind: "k",
        supported_job_types: "[]", max_concurrent_jobs: 1, current_active_jobs: 0,
        enabled: 0, drain: 0,
        last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        last_error: null,
      }],
    }),
    SESSIONS: makeKv(),
  };
  const b = await evaluateBreaches(env);
  assert.equal(b.filter((x) => x.kind === "node_down").length, 0);
});

test("evaluateBreaches: node_down does NOT fire for drained node", async () => {
  const env = {
    DB: makeDb({
      incidents: [],
      jobs: { depth: 0, oldest: null, failed_24h: 0 },
      nodes: [{
        id: "n_drain", name: "Drained", provider: "p", kind: "k",
        supported_job_types: "[]", max_concurrent_jobs: 1, current_active_jobs: 0,
        enabled: 1, drain: 1,
        last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        last_error: null,
      }],
    }),
    SESSIONS: makeKv(),
  };
  const b = await evaluateBreaches(env);
  assert.equal(b.filter((x) => x.kind === "node_down").length, 0);
});

test("evaluateBreaches: node_down fires when heartbeat is stale + node enabled", async () => {
  const env = {
    DB: makeDb({
      incidents: [],
      jobs: { depth: 0, oldest: null, failed_24h: 0 },
      nodes: [{
        id: "n1", name: "Node 1", provider: "p", kind: "k",
        supported_job_types: "[]", max_concurrent_jobs: 1, current_active_jobs: 0,
        enabled: 1, drain: 0,
        last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        last_error: null,
      }],
    }),
    SESSIONS: makeKv(),
  };
  const b = await evaluateBreaches(env);
  const nd = b.filter((x) => x.kind === "node_down");
  assert.equal(nd.length, 1);
  assert.equal(nd[0].signature, "node_down:n1");
});

test("evaluateBreaches: error_rate fires past threshold", async () => {
  const env = {
    DB: makeDb({
      incidents: [], jobs: { depth: 0, oldest: null, failed_24h: 0 },
      nodes: [], err_per_min: THRESHOLDS.ERROR_RATE_PER_MIN + 1,
    }),
    SESSIONS: makeKv(),
  };
  const b = await evaluateBreaches(env);
  assert.equal(b.filter((x) => x.kind === "error_rate").length, 1);
});

test("evaluateBreaches: d1_throttle fires past sustained threshold", async () => {
  const env = {
    DB: makeDb({
      incidents: [], jobs: { depth: 0, oldest: null, failed_24h: 0 },
      nodes: [], throttled_24h: THRESHOLDS.D1_THROTTLE_24H + 5,
    }),
    SESSIONS: makeKv(),
  };
  const b = await evaluateBreaches(env);
  assert.equal(b.filter((x) => x.kind === "d1_throttle").length, 1);
});

// ---------- runAlertEvaluator open/close/dedupe ---------------------------

test("runAlertEvaluator: opens incident on first breach", async () => {
  const state = {
    incidents: [],
    jobs: { depth: 5, oldest: new Date(Date.now() - 35 * 60_000).toISOString(), failed_24h: 0 },
    nodes: [],
  };
  const env = { DB: makeDb(state), SESSIONS: makeKv(), ALLOWED_EMAIL: "" };
  const r = await runAlertEvaluator(env);
  assert.equal(r.opened, 1);
  assert.equal(state.incidents.length, 1);
  assert.equal(state.incidents[0].signature, "queue_age:aidatasignal-lead-jobs");
});

test("runAlertEvaluator: dedupes — same breach twice opens one incident", async () => {
  const state = {
    incidents: [],
    jobs: { depth: 5, oldest: new Date(Date.now() - 35 * 60_000).toISOString(), failed_24h: 0 },
    nodes: [],
  };
  const env = { DB: makeDb(state), SESSIONS: makeKv(), ALLOWED_EMAIL: "" };
  await runAlertEvaluator(env);
  const r2 = await runAlertEvaluator(env);
  assert.equal(r2.opened, 0);
  assert.equal(state.incidents.length, 1);
});

test("runAlertEvaluator: closes after two consecutive recovered ticks", async () => {
  const state = {
    incidents: [],
    jobs: { depth: 5, oldest: new Date(Date.now() - 35 * 60_000).toISOString(), failed_24h: 0 },
    nodes: [],
  };
  const env = { DB: makeDb(state), SESSIONS: makeKv(), ALLOWED_EMAIL: "" };
  // Open
  await runAlertEvaluator(env);
  assert.equal(state.incidents[0].closed_at, null);
  // Now recover.
  state.jobs = { depth: 0, oldest: null, failed_24h: 0 };
  // First recovery tick — should NOT close yet.
  const r1 = await runAlertEvaluator(env);
  assert.equal(r1.closed, 0);
  assert.equal(state.incidents[0].closed_at, null);
  // Second recovery tick — should close.
  const r2 = await runAlertEvaluator(env);
  assert.equal(r2.closed, 1);
  assert.ok(state.incidents[0].closed_at);
});

test("runAlertEvaluator: recovery counter resets when breach returns", async () => {
  const state = {
    incidents: [],
    jobs: { depth: 5, oldest: new Date(Date.now() - 35 * 60_000).toISOString(), failed_24h: 0 },
    nodes: [],
  };
  const env = { DB: makeDb(state), SESSIONS: makeKv(), ALLOWED_EMAIL: "" };
  await runAlertEvaluator(env);
  // Recover once.
  state.jobs = { depth: 0, oldest: null, failed_24h: 0 };
  await runAlertEvaluator(env);
  // Breach again — counter must reset.
  state.jobs = { depth: 5, oldest: new Date(Date.now() - 35 * 60_000).toISOString(), failed_24h: 0 };
  await runAlertEvaluator(env);
  // Recover once more — should NOT close yet (counter reset).
  state.jobs = { depth: 0, oldest: null, failed_24h: 0 };
  const r = await runAlertEvaluator(env);
  assert.equal(r.closed, 0);
  assert.equal(state.incidents[0].closed_at, null);
});

test("runAlertEvaluator: cold install (all tables throw) is a no-op", async () => {
  const throwingDb = {
    prepare() {
      const stmt = {
        bind() { return stmt; },
        async first() { throw new Error("no such table"); },
        async all() { throw new Error("no such table"); },
        async run() { return { meta: { changes: 0 } }; },
      };
      return stmt;
    },
  };
  const env = { DB: throwingDb, SESSIONS: makeKv(), ALLOWED_EMAIL: "" };
  // Should not throw.
  const r = await runAlertEvaluator(env);
  assert.equal(r.opened, 0);
  assert.equal(r.closed, 0);
});
