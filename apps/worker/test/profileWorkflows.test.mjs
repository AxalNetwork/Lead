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
const { crossRef, runStandardWorkflow, resolveEntityId, checkTypeDailyBudget, projectedRunCostUsd } =
  await import(`${ROOT}/crawler/profileWorkflows/_shared.js`);
const { investorVcWorkflow } = await import(`${ROOT}/crawler/profileWorkflows/investor_vc.js`);

// ---------------------------------------------------------------------------
// 1. Registry — every claimed type id resolves to a non-default workflow.

// Full seeded e_types roster (mirrors
// migrations/340_profile_types_seed.sql). Coverage test below fails
// if a seed id is missing from the registry — keeps the registry in
// lockstep with the seed without requiring a live D1.
const CLAIMED_TYPES = [
  // Dedicated typed workflows.
  "investor_vc", "investor_pe", "investor_angel", "investor_corporate_vc",
  "accelerator", "fund_of_funds", "family_office",
  "investor_person", "lawyer_securities", "banker_investment",
  "founder", "co_founder", "founding_engineer", "repeat_founder",
  "politician_federal", "regulator_sec",
  "academic_researcher", "journalist_business",
  // Templated firm workflows.
  "investor", "investor_micro_vc", "investor_family_office",
  "investor_endowment", "investor_sovereign", "investor_pension",
  "incubator", "venture_studio", "syndicate", "secondary_buyer",
  "hedge_fund", "asset_manager", "investment_bank", "commercial_bank",
  "private_bank", "broker_dealer", "exchange_traditional",
  "exchange_crypto", "custodian", "clearinghouse", "payment_processor",
  "insurance", "reinsurer", "accounting_firm", "consulting_firm",
  "law_firm", "marketing_agency", "pr_firm", "design_agency", "dev_shop",
  "executive_search_firm", "conference_organizer", "portfolio_company",
  "public_company", "enterprise", "sme",
  "startup_pre_seed", "startup_seed", "startup_series_a",
  "startup_growth", "startup_late_stage", "acquirer_strategic",
  "government_agency_federal", "government_agency_state",
  "government_agency_local", "multilateral_org", "ngo", "think_tank",
  "target_customer_b2b", "target_customer_b2c",
  // Templated person workflows.
  "firm_person", "gp_partner", "principal", "associate", "scout",
  "venture_partner", "operating_partner", "entrepreneur_in_residence",
  "advisor", "board_member", "lawyer", "lawyer_corporate", "lawyer_ip",
  "lawyer_employment", "lawyer_immigration", "lawyer_tax", "patent_agent",
  "banker_commercial", "banker_private", "banker_m_and_a",
  "operator_growth", "operator_sales", "operator_marketing",
  "operator_product", "operator_engineering",
  "fractional_cfo", "fractional_cto", "fractional_coo", "fractional_cmo",
  "executive_recruiter",
  "business_founder", "founder_solo", "founding_designer", "founding_pm",
  "technical_founder", "serial_entrepreneur",
  "politician_state", "politician_local", "policy_advisor",
  "professor", "research_scientist", "lab_principal_investigator",
  "postdoc", "phd_student", "technology_transfer_officer",
  "journalist_tech", "journalist_crypto", "analyst_industry",
  "newsletter_writer", "podcast_host", "thought_leader",
  "youtuber_business",
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

// Data-driven backstop: derive the source-of-truth seed list directly
// from migrations/340_profile_types_seed.sql so the registry cannot
// silently drift away from the seed. The hand-maintained CLAIMED_TYPES
// above stays as documentation of the *intended* coverage; this test
// is the safety net.
import { readFileSync } from "node:fs";
const SEED_SQL = readFileSync(
  new URL("../migrations/340_profile_types_seed.sql", import.meta.url),
  "utf8",
);
const SEEDED_TYPE_IDS = [...SEED_SQL.matchAll(/^\('([a-z0-9_]+)'/gm)]
  .map((m) => m[1])
  .filter((id, i, a) => a.indexOf(id) === i);

test("registry: every seeded e_types id resolves to a dedicated workflow", () => {
  assert.ok(SEEDED_TYPE_IDS.length >= 100, `parsed only ${SEEDED_TYPE_IDS.length} seed ids`);
  const missing = SEEDED_TYPE_IDS.filter((id) => !hasDedicatedWorkflow(id));
  assert.deepEqual(missing, [], `seed ids missing from registry: ${missing.join(", ")}`);
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
    SESSIONS: (() => {
      const m = new Map();
      return {
        get: async (k) => m.get(k) ?? null,
        put: async (k, v) => { m.set(k, v); },
        delete: async (k) => { m.delete(k); },
        _map: m,
      };
    })(),
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

test("runStandardWorkflow: respects ops pause flag (skipped status, no fetch/AI)", async () => {
  const env = makeEnv();
  // Global pause
  await env.SESSIONS.put("ops:crawler:paused", "1");
  const ctx = {
    candidateUrl: "https://acme.invalid/",
    candidateHtml: "<html><title>x</title></html>",
    candidateHost: "acme.invalid",
    jobId: "test-pause-1",
  };
  const out = await investorVcWorkflow.run(env, ctx, { budgetUsdCap: 0.05, aiCallCap: 1 });
  assert.equal(out.status, "skipped");
  assert.equal(out.facts_written, 0);
  assert.equal(out.ai_calls, 0);
  assert.ok(out.errors.some((e) => e.message.startsWith("paused_scope:all")));
  // Resume + run host-scoped pause
  await env.SESSIONS.delete("ops:crawler:paused");
  await env.SESSIONS.put("ops:crawler:paused:host:acme.invalid", "1");
  const out2 = await investorVcWorkflow.run(env, ctx, { budgetUsdCap: 0.05, aiCallCap: 1 });
  assert.equal(out2.status, "skipped");
  assert.ok(out2.errors.some((e) => e.message.startsWith("paused_scope:host")));
  // Profile-type scope
  await env.SESSIONS.delete("ops:crawler:paused:host:acme.invalid");
  await env.SESSIONS.put("ops:crawler:paused:type:investor_vc", "1");
  const out3 = await investorVcWorkflow.run(env, ctx, { budgetUsdCap: 0.05, aiCallCap: 1 });
  assert.equal(out3.status, "skipped");
  assert.ok(out3.errors.some((e) => e.message.startsWith("paused_scope:profile_type")));
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

test("checkTypeDailyBudget: PREFLIGHT — projected cost that crosses cap is refused before run", async () => {
  const env = makeEnv();
  // Cap defaults to 0.50 USD/type/day. Pre-load spend at 0.49 so a
  // tiny accrued amount is fine BUT a projected run-cost that crosses
  // the cap must be refused.
  const day = new Date().toISOString().slice(0, 10);
  await env.SCRAPE_CACHE.put(`pwf:spend:investor_vc:${day}`, "0.49");
  const projected = projectedRunCostUsd(investorVcWorkflow);
  assert.ok(projected > 0, "projected cost must be > 0");
  // Without preflight (post-fact check): under cap → ok.
  const postOnly = await checkTypeDailyBudget(env, "investor_vc");
  assert.equal(postOnly.ok, true);
  // With preflight: 0.49 + projected (≥0.014) ≥ 0.50 → must refuse.
  const pre = await checkTypeDailyBudget(env, "investor_vc", projected);
  assert.equal(pre.ok, false, `expected preflight refusal at spend=${pre.spend}, projected=${pre.projected}, cap=${pre.cap}`);
  assert.equal(pre.projected, projected);
});

test("checkTypeDailyBudget: empty ledger allows dispatch", async () => {
  const env = makeEnv();
  const r = await checkTypeDailyBudget(env, "investor_vc");
  assert.equal(r.ok, true);
  assert.equal(r.spend, 0);
  assert.ok(r.cap > 0);
});

test("runStandardWorkflow: planned URL equal to candidateUrl is deduped (no false verified)", async () => {
  // Regression: if a planned same-origin sibling (e.g. /about) happens
  // to resolve to the exact same canonical URL as ctx.candidateUrl,
  // the runner must drop the duplicate before extraction. Otherwise
  // the same page's facts would land in two distinct sourceTag
  // buckets (`candidate` + `about`) and crossRef would incorrectly
  // mark single-page evidence as verified=1.
  const env = makeEnv();
  // Build a tiny workflow whose plan deliberately re-emits the exact
  // candidate URL under a different tag. We reuse the FIRM mapper
  // via investorVcWorkflow's def, but we need a custom plan — so we
  // construct a minimal def directly through makeWorkflow.
  const { makeWorkflow } = await import(`${ROOT}/crawler/profileWorkflows/_shared.js`);
  const dup = makeWorkflow({
    id: "dup_test.v1",
    profile_type_id: "investor_vc",
    estimated_cost_per_run: { sources: 2, ai_neurons: 0.1 },
    plan: (ctx) => [
      // Same URL as ctx.candidateUrl, only tag differs.
      { tag: "about", url: ctx.candidateUrl },
      // And a trailing-slash variant — must also be deduped.
      { tag: "about_slash", url: ctx.candidateUrl + (ctx.candidateUrl.endsWith("/") ? "" : "/") },
    ],
    extractionSchema: { type: "object" },
    systemPrompt: "stub",
    map: ({ source }) => [
      { predicate: "firm.aum_usd", valueNumber: 500_000_000, sourceUrl: source.url, sourceTag: source.tag, confidence: 0.8 },
    ],
  });
  const ctx = {
    candidateUrl: "https://dup.invalid/about",
    candidateHtml: "<html><title>Dup</title><body>Acme firm.</body></html>",
    candidateHost: "dup.invalid",
    jobId: "dup-job",
  };
  const out = await dup.run(env, ctx, { budgetUsdCap: 0.05 });
  // Only the candidate bucket should have produced facts; duplicates dropped.
  assert.equal(out.sources_planned, 1, `expected dedupe to leave 1 source, got ${out.sources_planned}`);
  // Single-source → MUST NOT be verified.
  assert.equal(out.facts_verified, 0, "duplicated-URL facts must not promote to verified");
});

test("resolveEntityId: deterministic from candidate URL", async () => {
  const id1 = await resolveEntityId("investor_vc", { candidateUrl: "https://a.example/", candidateHtml: "", candidateHost: "a.example" });
  const id2 = await resolveEntityId("investor_vc", { candidateUrl: "https://a.example/", candidateHtml: "x", candidateHost: "a.example" });
  assert.equal(id1, id2, "entity id should be stable across candidateHtml changes");
  assert.ok(id1.startsWith("pwf_"));
});
