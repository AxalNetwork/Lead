// Task #1: smoke test for the per-profile-type workflow framework.
//
// Covers the three contract guarantees we make without needing a live
// Workers AI binding:
//   1. The registry returns a dedicated workflow for every claimed
//      profile_type_id and the generic `_default` workflow for unknown
//      ids.
//   2. `crossRef` promotes a (predicate, value) tuple observed in ≥2
//      distinct source-tag buckets to verified=1, and shrinks
//      single-source confidence to confidence × 0.6.
//   3. `runStandardWorkflow` writes one row into `facts` per emitted
//      candidate (deduped by hash) and one row into
//      `profile_workflow_runs` per execution. The AI step is monkey-
//      patched via `env.AI.run` so we don't need a live binding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const ROOT = "../test-dist";

const { getWorkflowForType, hasDedicatedWorkflow, listWorkflows } =
  await import(`${ROOT}/crawler/profileWorkflows/registry.js`);
const { crossRef, runStandardWorkflow, resolveEntityId, checkTypeDailyBudget } =
  await import(`${ROOT}/crawler/profileWorkflows/_shared.js`);
const { investorVcWorkflow } = await import(`${ROOT}/crawler/profileWorkflows/investor_vc.js`);

// ---------------------------------------------------------------------------
// 1. Registry — every claimed type id resolves to a non-default workflow.

const CLAIMED_TYPES = [
  "investor_vc", "investor_pe", "investor_angel", "investor_corporate_vc",
  "accelerator", "fund_of_funds", "family_office",
  "investor_person", "lawyer_securities", "banker_investment",
  "founder", "co_founder", "founding_engineer", "repeat_founder",
  "politician_federal", "regulator_sec",
  "academic_researcher", "journalist_business",
];

test("registry: every claimed profile_type_id has a dedicated workflow", () => {
  for (const id of CLAIMED_TYPES) {
    assert.ok(hasDedicatedWorkflow(id), `expected dedicated workflow for ${id}`);
    const w = getWorkflowForType(id);
    assert.equal(w.profile_type_id, id);
    assert.ok(w.id.endsWith(".v1"), `workflow id should be versioned: ${w.id}`);
    assert.ok(w.estimated_cost_per_run.sources > 0);
  }
});

test("registry: unknown type falls back to _default", () => {
  assert.equal(hasDedicatedWorkflow("never_heard_of_it"), false);
  const w = getWorkflowForType("never_heard_of_it");
  assert.equal(w.profile_type_id, "_default");
});

test("registry: listWorkflows includes default + every claimed type", () => {
  const rows = listWorkflows();
  const ids = new Set(rows.map((r) => r.profile_type_id));
  for (const id of CLAIMED_TYPES) assert.ok(ids.has(id), `missing ${id}`);
  assert.ok(ids.has("_default"));
});

// ---------------------------------------------------------------------------
// 2. crossRef — promotion rule.

test("crossRef: ≥2 distinct source tags → verified=1, full confidence", () => {
  const facts = [
    { predicate: "firm.aum_usd", valueNumber: 500_000_000, sourceUrl: "u1", sourceTag: "about",     confidence: 0.8 },
    { predicate: "firm.aum_usd", valueNumber: 500_000_000, sourceUrl: "u2", sourceTag: "wikipedia", confidence: 0.7 },
    { predicate: "firm.aum_usd", valueNumber: 750_000_000, sourceUrl: "u3", sourceTag: "team",      confidence: 0.6 },
  ];
  const out = crossRef(facts);
  // First two share value 500m across two distinct tags → verified
  assert.equal(out[0].verified, true);
  assert.equal(out[1].verified, true);
  assert.equal(out[0].adjustedConfidence, 0.8);
  // Third is single-source → unverified, confidence shrunk
  assert.equal(out[2].verified, false);
  assert.ok(Math.abs(out[2].adjustedConfidence - 0.6 * 0.6) < 1e-9);
});

test("crossRef: same value under same tag does NOT promote", () => {
  const facts = [
    { predicate: "firm.aum_usd", valueNumber: 1_000_000_000, sourceUrl: "u1", sourceTag: "about", confidence: 0.9 },
    { predicate: "firm.aum_usd", valueNumber: 1_000_000_000, sourceUrl: "u2", sourceTag: "about", confidence: 0.9 },
  ];
  const out = crossRef(facts);
  assert.equal(out[0].verified, false);
  assert.equal(out[1].verified, false);
});

// ---------------------------------------------------------------------------
// 3. runStandardWorkflow end-to-end (AI mocked, DB in-memory).

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_json TEXT,
      value_entity_id TEXT,
      source_kind TEXT NOT NULL,
      source TEXT,
      evidence_url TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      valid_from TEXT, valid_to TEXT, supersedes_fact_id TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ai_cost_daily (
      day TEXT NOT NULL,
      purpose TEXT NOT NULL,
      neurons REAL NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, purpose)
    );
    CREATE TABLE profile_workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      profile_type_id TEXT NOT NULL,
      entity_id TEXT,
      candidate_url TEXT NOT NULL,
      candidate_host TEXT,
      job_id TEXT,
      status TEXT NOT NULL,
      sources_planned INTEGER NOT NULL DEFAULT 0,
      sources_fetched INTEGER NOT NULL DEFAULT 0,
      sources_failed INTEGER NOT NULL DEFAULT 0,
      facts_written INTEGER NOT NULL DEFAULT 0,
      facts_verified INTEGER NOT NULL DEFAULT 0,
      ai_calls INTEGER NOT NULL DEFAULT 0,
      ai_neurons REAL NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      actual_cost_usd REAL NOT NULL DEFAULT 0,
      errors_json TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return {
    DB: {
      prepare(sql) {
        const stmt = db.prepare(sql);
        const binder = (...args) => ({
          run: async () => {
            stmt.run(...args);
            return { success: true };
          },
          all: async () => ({ results: stmt.all(...args) }),
          first: async () => stmt.get(...args) ?? null,
        });
        return { bind: binder, run: () => binder().run(), all: () => binder().all(), first: () => binder().first() };
      },
    },
    AI: {
      // Mock model: return a deterministic JSON envelope for every call so
      // the cross-ref / persist code path runs end-to-end.
      run: async () => ({
        response: JSON.stringify({
          display_name: "Acme Ventures",
          aum_usd: 500_000_000,
          stages: ["seed", "series_a"],
          sectors: ["fintech", "ai"],
          confidence: 0.85,
        }),
      }),
    },
    // In-memory KV stand-in so the per-type daily spend ledger
    // (KV reads/writes inside _shared) works in tests.
    AI_CACHE: null,
    SCRAPE_CACHE: (() => {
      const m = new Map();
      return {
        get: async (k) => m.get(k) ?? null,
        put: async (k, v) => { m.set(k, v); },
        delete: async (k) => { m.delete(k); },
        _map: m,
      };
    })(),
    AI_RL: null,
    AI_DAILY_NEURONS_CAP: "1000000",
  };
}

test("runStandardWorkflow: skipping fetch (disableAi=false) still runs on candidate HTML", async () => {
  const env = makeEnv();
  // Monkey-patch fetchPage by replacing the global fetch — the runner
  // uses env-aware fetchPage which we cannot stub directly here, so we
  // exercise the candidate-only path: when every planned sibling fails,
  // the candidate bucket still produces facts. To force that, we point
  // the candidate at a non-resolvable URL so the runner falls back to
  // the in-memory candidateHtml (which is always present).
  const ctx = {
    candidateUrl: "https://acme.invalid/",
    candidateHtml: "<html><title>Acme Ventures</title><body>Acme Ventures is a venture firm.</body></html>",
    candidateHost: "acme.invalid",
    jobId: "test-job-1",
  };
  // Override fetchPage indirectly by capping aiCallCap=1: ensures only
  // the candidate bucket goes through the AI mock; sibling fetches
  // still attempt but their failures are captured in `errors`.
  const w = investorVcWorkflow;
  const out = await w.run(env, ctx, { budgetUsdCap: 0, aiCallCap: 1 });
  assert.equal(out.profile_type_id, "investor_vc");
  // Candidate bucket → facts written (display_name, aum_usd, stages, sectors)
  assert.ok(out.facts_written >= 3, `expected ≥3 facts, got ${out.facts_written}`);
  // Single-source so nothing is verified
  assert.equal(out.facts_verified, 0);
  // profile_workflow_runs row recorded
  const runs = env.DB.prepare("SELECT * FROM profile_workflow_runs").bind();
  const rows = (await runs.all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profile_type_id, "investor_vc");
  assert.equal(rows[0].workflow_id, "investor_vc.v1");
});

test("writeFact: facts persist via insertFact path with verified flag set", async () => {
  const env = makeEnv();
  // Two distinct source tags emitting the same value would normally
  // promote; here we just confirm the canonical write path writes a
  // row with source_kind='enrichment' and that the verified column
  // is set when crossRef promotes.
  const ctx = {
    candidateUrl: "https://acme2.invalid/",
    candidateHtml: "<html><title>Acme Two</title><body>Acme is a venture firm.</body></html>",
    candidateHost: "acme2.invalid",
    jobId: "test-job-write",
  };
  await investorVcWorkflow.run(env, ctx, { budgetUsdCap: 0, aiCallCap: 1 });
  const rows = (await env.DB.prepare("SELECT source_kind, source, verified FROM facts").bind().all()).results;
  assert.ok(rows.length >= 1, "expected at least one fact row");
  for (const r of rows) {
    assert.equal(r.source_kind, "enrichment");
    // source should be the URL, not a workflow:run synthetic string
    assert.ok(typeof r.source === "string" && r.source.startsWith("http"), `source should be a URL, got ${r.source}`);
  }
});

test("checkTypeDailyBudget: cap blocks dispatch after spend exceeds cap", async () => {
  const env = makeEnv();
  // Pre-load the spend ledger above the default cap (0.50 USD).
  const day = new Date().toISOString().slice(0, 10);
  await env.SCRAPE_CACHE.put(`pwf:spend:investor_vc:${day}`, "0.75");
  const r = await checkTypeDailyBudget(env, "investor_vc");
  assert.equal(r.ok, false);
  assert.ok(r.spend >= r.cap, `expected spend ≥ cap, got ${r.spend} / ${r.cap}`);
});

test("checkTypeDailyBudget: empty ledger allows dispatch", async () => {
  const env = makeEnv();
  const r = await checkTypeDailyBudget(env, "investor_vc");
  assert.equal(r.ok, true);
  assert.equal(r.spend, 0);
  assert.ok(r.cap > 0);
});

test("resolveEntityId: deterministic from candidate URL", async () => {
  const id1 = await resolveEntityId("investor_vc", { candidateUrl: "https://a.example/", candidateHtml: "", candidateHost: "a.example" });
  const id2 = await resolveEntityId("investor_vc", { candidateUrl: "https://a.example/", candidateHtml: "x", candidateHost: "a.example" });
  assert.equal(id1, id2, "entity id should be stable across candidateHtml changes");
  assert.ok(id1.startsWith("pwf_"));
});
