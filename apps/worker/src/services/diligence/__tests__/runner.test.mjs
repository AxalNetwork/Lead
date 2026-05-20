// Task #6: runner orchestration tests. Validates:
//   - executeCheck persists exactly one row even when the executor throws
//   - executeCheck mirrors derived_facts through insertFact for pass results
//   - rerunFailed creates a NEW run with parent_run_id and only re-dispatches
//     fail | caution | needs_human keys
//   - registered unknown check_key surfaces as a needs_human row, not a throw
import { test } from "node:test";
import assert from "node:assert/strict";

const { executeCheck, rerunFailed } =
  await import("../../../../test-dist/services/diligence/runner.js");
const { REGISTRY } =
  await import("../../../../test-dist/services/diligence/registry.js");

// In-memory mock DB capturing inserts.
function makeEnv() {
  const tables = {
    diligence_check_results: [],
    diligence_runs: [],
    facts: [], // populated by insertFact
  };
  function prepare(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    let args = [];
    return {
      bind(...a) { args = a; return this; },
      run() {
        if (/INSERT INTO diligence_check_results/.test(s)) {
          tables.diligence_check_results.push({
            id: args[0], run_id: args[1], check_key: args[2], section: args[3],
            title: args[4], status: args[5], severity: args[6], confidence: args[7],
            finding_md: args[8], evidence_json: args[9], flagged_for_human: args[10],
            duration_ms: args[11],
          });
          return Promise.resolve();
        }
        if (/INSERT INTO diligence_runs/.test(s)) {
          // New runner binds: id, template_id, target_entity_id, triggered_by,
          // checks_total, by_status_json, [parent_run_id]. Rerun adds the
          // 7th positional arg.
          tables.diligence_runs.push({
            id: args[0], template_id: args[1], target_entity_id: args[2],
            triggered_by: args[3], checks_total: args[4],
            by_status_json: args[5] ?? null,
            parent_run_id: args[6] ?? null,
          });
          return Promise.resolve();
        }
        if (/UPDATE diligence_runs/.test(s)) {
          return Promise.resolve();
        }
        // insertFact's INSERT INTO facts path:
        if (/INSERT INTO facts/.test(s)) {
          tables.facts.push({ args, sql: s });
          return Promise.resolve({ meta: { last_row_id: tables.facts.length } });
        }
        // insertFact's supersede UPDATE on prior facts row:
        if (/UPDATE facts SET is_current/.test(s)) return Promise.resolve();
        if (/SELECT/.test(s) && /FROM facts/.test(s)) {
          // prior-fact lookup inside insertFact — return null (no prior)
          return Promise.resolve();
        }
        if (/INSERT INTO fact_audit/.test(s)) return Promise.resolve();
        return Promise.resolve();
      },
      first() {
        if (/SELECT id, template_id, target_entity_id, triggered_by FROM diligence_runs/.test(s)) {
          const r = tables.diligence_runs.find((r) => r.id === args[0]);
          return Promise.resolve(r ?? null);
        }
        // Prior fact lookup in insertFact.
        if (/SELECT/.test(s) && /FROM facts/.test(s)) return Promise.resolve(null);
        return Promise.resolve(null);
      },
      all() {
        if (/SELECT check_key, status FROM diligence_check_results/.test(s)) {
          const rows = tables.diligence_check_results.filter((r) => r.run_id === args[0]);
          return Promise.resolve({ results: rows.map((r) => ({ check_key: r.check_key, status: r.status })) });
        }
        return Promise.resolve({ results: [] });
      },
    };
  }
  return { env: { DB: { prepare } }, tables };
}

test("executeCheck — registered unknown check_key persists a needs_human row instead of throwing", async () => {
  const { env, tables } = makeEnv();
  const r = await executeCheck(env, "run_1", { env, target_entity_id: "ent_1", triggered_by: "op@x" }, "does.not.exist");
  assert.equal(r.status, "needs_human");
  assert.equal(tables.diligence_check_results.length, 1);
  assert.equal(tables.diligence_check_results[0].check_key, "does.not.exist");
});

test("executeCheck — throwing executor downgrades to needs_human and persists exactly one row", async () => {
  const { env, tables } = makeEnv();
  // Inject a fake check that throws.
  REGISTRY.set("__test.thrower", {
    key: "__test.thrower", section: "corporate", title: "Thrower", severity: "low",
    run: async () => { throw new Error("boom"); },
  });
  const r = await executeCheck(env, "run_1", { env, target_entity_id: "ent_1", triggered_by: "op@x" }, "__test.thrower");
  REGISTRY.delete("__test.thrower");
  assert.equal(r.status, "needs_human");
  assert.equal(r.reason, "executor_threw");
  assert.equal(tables.diligence_check_results.length, 1);
});

test("executeCheck — pass derived_facts are mirrored through insertFact", async () => {
  const { env, tables } = makeEnv();
  REGISTRY.set("__test.passer", {
    key: "__test.passer", section: "corporate", title: "Passer", severity: "low",
    run: async () => ({
      status: "pass", severity: "low", confidence: 0.9,
      finding_md: "ok", evidence: [],
      derived_facts: [{ predicate: "diligence.test.ok", value_text: "true" }],
    }),
  });
  await executeCheck(env, "run_1", { env, target_entity_id: "ent_1", triggered_by: "op@x" }, "__test.passer");
  REGISTRY.delete("__test.passer");
  const factInserts = tables.facts.filter((f) => /INSERT INTO facts/.test(f.sql));
  assert.ok(factInserts.length >= 1, "expected at least one INSERT INTO facts");
});

test("executeCheck — needs_human results do NOT mirror facts", async () => {
  const { env, tables } = makeEnv();
  REGISTRY.set("__test.needs", {
    key: "__test.needs", section: "corporate", title: "Needs", severity: "low",
    run: async () => ({
      status: "needs_human", severity: "low", confidence: 0,
      finding_md: "nope", evidence: [],
      derived_facts: [{ predicate: "diligence.test.should_not_appear", value_text: "true" }],
    }),
  });
  await executeCheck(env, "run_1", { env, target_entity_id: "ent_1", triggered_by: "op@x" }, "__test.needs");
  REGISTRY.delete("__test.needs");
  assert.equal(tables.facts.length, 0, "needs_human must not mirror facts");
});

test("rerunFailed — creates new run with parent_run_id and only re-dispatches fail-like keys", async () => {
  const { env, tables } = makeEnv();
  // Seed parent run.
  tables.diligence_runs.push({ id: "parent_1", template_id: "t", target_entity_id: "ent_1", triggered_by: "op@x", checks_total: 3 });
  // Seed prior results.
  tables.diligence_check_results.push(
    { id: "a", run_id: "parent_1", check_key: "k.pass",    status: "pass" },
    { id: "b", run_id: "parent_1", check_key: "k.fail",    status: "fail" },
    { id: "c", run_id: "parent_1", check_key: "k.needs",   status: "needs_human" },
    { id: "d", run_id: "parent_1", check_key: "k.caution", status: "caution" },
    { id: "e", run_id: "parent_1", check_key: "k.na",      status: "n/a" },
  );
  // Register the three fail-like keys as no-op passes so the rerun completes.
  for (const k of ["k.fail", "k.needs", "k.caution"]) {
    REGISTRY.set(k, { key: k, section: "corporate", title: k, severity: "low",
      run: async () => ({ status: "pass", severity: "low", confidence: 1, finding_md: "ok", evidence: [] }) });
  }
  const summary = await rerunFailed(env, { parent_run_id: "parent_1", triggered_by: "op@x" });
  for (const k of ["k.fail", "k.needs", "k.caution"]) REGISTRY.delete(k);
  assert.ok(summary, "rerun should produce a summary");
  assert.equal(summary.checks_total, 3, "only fail-like keys rerun (3)");
  // A second diligence_runs row was inserted with parent_run_id set.
  const childRuns = tables.diligence_runs.filter((r) => r.parent_run_id === "parent_1");
  assert.equal(childRuns.length, 1);
});

test("rerunFailed — returns null when nothing to rerun", async () => {
  const { env, tables } = makeEnv();
  tables.diligence_runs.push({ id: "parent_2", template_id: "t", target_entity_id: "ent_1", triggered_by: "op@x", checks_total: 1 });
  tables.diligence_check_results.push({ id: "a", run_id: "parent_2", check_key: "k.pass", status: "pass" });
  const summary = await rerunFailed(env, { parent_run_id: "parent_2", triggered_by: "op@x" });
  assert.equal(summary, null);
});
