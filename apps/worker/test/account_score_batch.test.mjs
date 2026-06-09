// Task #54: the nightly account-score sweep and the buyer-role backfill
// were per-row N+1 loops. These tests drive the real repo functions against
// a fake D1 that records every prepared SQL string + bound args, proving:
//   (1) recomputeStaleAccountScores issues a FIXED read budget (accounts,
//       signals, buyers, taxonomy) regardless of how many accounts are
//       stale — the prior 4×N reads are gone — and flushes updates via
//       DB.batch();
//   (2) its persisted scores are byte-identical to computing them directly
//       with the same pure functions (output parity);
//   (3) backfillBuyerRoles flushes its UPDATEs through DB.batch() instead of
//       one serial .run() per row, with unchanged scanned/matched/updated
//       counts.
// Plus a source-contract check that the cron + orchestrator are wired to
// the batched paths (including the re-enrichment preloadedLead handoff).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { recomputeStaleAccountScores, backfillBuyerRoles } = await import("../test-dist/prospects/repo.js");
const { computeIntent, blendAccountScore } = await import("../test-dist/prospects/score.js");
const { computeFit, DEFAULT_ICP } = await import("../test-dist/prospects/fit.js");

function account(id, over = {}) {
  return {
    id, name: id, legal_name: null, domain: null, website: null, logo_id: null, description: null,
    industry: "saas", industries_json: null, size_band: "201-500", employees: 300, founded_year: null,
    hq_country_iso2: "US", hq_region: null, hq_city: null, timezone: null, funding_stage: "series_b",
    total_funding_usd: null, last_round_usd: null, last_round_at: null, revenue_band: null,
    linkedin_url: null, crunchbase_url: null, twitter_handle: null, github_org: null,
    status: "active", owner_email: null, fit_score: 0, intent_score: 0, account_score: 0,
    fit_breakdown_json: null, intent_breakdown_json: null, score_recomputed_at: null,
    embedding_dim: null, embedded_at: null, source_url: null, imported_from: null, meta_json: null,
    last_enriched_at: null, created_at: "", updated_at: "", ...over,
  };
}
function buyer(id, accountId, over = {}) {
  return {
    id, account_id: accountId, name: id, email: null, title: "CTO", role_slug: "cto",
    seniority: "c_suite", department: "engineering", linkedin_url: null, twitter_url: null, phone: null,
    is_decision_maker: 1, is_champion: 0, influence_score: 80, last_seen_at: null, meta_json: null,
    created_at: "", updated_at: "", ...over,
  };
}

// recent so the decay term is ~1 and round2 scores are deterministic.
const RECENT = new Date(Date.now() - 60_000).toISOString();

function makeScoreEnv({ accounts, signalsByAcct = {}, buyersByAcct = {} }) {
  const reads = [];
  const batched = [];
  function stmt(sql) {
    return {
      sql, _binds: [],
      bind(...a) { this._binds = a; return this; },
      async all() {
        reads.push(sql);
        // signals/buyers queries embed `... FROM accounts` in their IN(...)
        // subquery, so match the most specific tables FIRST.
        if (/FROM signals/.test(sql)) {
          const out = [];
          for (const a of accounts) for (const s of signalsByAcct[a.id] ?? []) out.push({ account_id: a.id, ...s });
          return { results: out };
        }
        if (/FROM buyers/.test(sql)) {
          const out = [];
          for (const a of accounts) for (const b of buyersByAcct[a.id] ?? []) out.push(b);
          return { results: out };
        }
        if (/FROM role_taxonomy/.test(sql)) return { results: [] };
        if (/FROM accounts/.test(sql)) return { results: accounts };
        return { results: [] };
      },
      async first() { reads.push(sql); return null; },
      async run() { return { meta: {} }; },
    };
  }
  return {
    env: {
      DB: {
        prepare(sql) { return stmt(sql); },
        async batch(stmts) { for (const s of stmts) batched.push({ sql: s.sql, binds: s._binds }); return stmts.map(() => ({})); },
      },
    },
    reads, batched,
  };
}

test("recomputeStaleAccountScores uses a fixed read budget regardless of N", async () => {
  const accounts = [account("a1"), account("a2"), account("a3")];
  const { env, reads, batched } = makeScoreEnv({
    accounts,
    signalsByAcct: {
      a1: [{ kind: "demo_request", weight: 8, confidence: 1, occurred_at: RECENT }],
      a2: [{ kind: "pricing_view", weight: 5, confidence: 0.9, occurred_at: RECENT }],
      // a3 intentionally has no signals
    },
    buyersByAcct: { a1: [buyer("b1", "a1")] },
  });
  const r = await recomputeStaleAccountScores(env, 1000);
  assert.deepEqual(r, { scanned: 3, updated: 3 });

  // Exactly four reads: accounts, signals, buyers, role_taxonomy — NOT 4×N.
  assert.equal(reads.length, 4, `expected 4 reads, got ${reads.length}: ${reads.join(" | ")}`);
  // the main accounts read selects rows directly (no `account_id IN` subquery).
  assert.equal(reads.filter((s) => /FROM accounts/.test(s) && !/account_id IN/.test(s)).length, 1);
  assert.equal(reads.filter((s) => /FROM signals/.test(s)).length, 1);
  assert.equal(reads.filter((s) => /FROM buyers/.test(s)).length, 1);
  assert.equal(reads.filter((s) => /FROM role_taxonomy/.test(s)).length, 1);
  // The per-account getAccount N+1 is gone (no `WHERE id = ?` single reads).
  assert.equal(reads.filter((s) => /WHERE id = \?/.test(s)).length, 0);
  // Updates flushed via batch, one statement per account.
  assert.equal(batched.length, 3);
});

test("recomputeStaleAccountScores output is byte-identical to the pure scorers", async () => {
  const accounts = [
    account("a1", { industry: "fintech" }),
    account("a2", { hq_country_iso2: "ZZ", industry: "agriculture", funding_stage: "bootstrapped", size_band: "1-10", employees: 4 }),
  ];
  const signalsByAcct = {
    a1: [
      { kind: "demo_request", weight: 8, confidence: 1, occurred_at: RECENT },
      { kind: "pricing_view", weight: 4, confidence: 0.8, occurred_at: RECENT },
    ],
    a2: [],
  };
  const buyersByAcct = { a1: [buyer("b1", "a1")], a2: [] };
  const { env, batched } = makeScoreEnv({ accounts, signalsByAcct, buyersByAcct });
  await recomputeStaleAccountScores(env, 1000);

  for (const acc of accounts) {
    const stmt = batched.find((b) => b.binds[7] === acc.id);
    assert.ok(stmt, `missing update for ${acc.id}`);
    const intent = computeIntent(signalsByAcct[acc.id] ?? []);
    const fit = computeFit(acc, buyersByAcct[acc.id] ?? [], new Map(), DEFAULT_ICP);
    const expectedAccount = blendAccountScore(intent.intent_score, fit.fit_score);
    assert.equal(stmt.binds[0], intent.intent_score, `intent_score ${acc.id}`);
    assert.equal(stmt.binds[1], fit.fit_score, `fit_score ${acc.id}`);
    assert.equal(stmt.binds[2], expectedAccount, `account_score ${acc.id}`);
  }
});

test("recomputeStaleAccountScores no-ops cleanly when nothing is stale", async () => {
  const { env, reads, batched } = makeScoreEnv({ accounts: [] });
  const r = await recomputeStaleAccountScores(env, 1000);
  assert.deepEqual(r, { scanned: 0, updated: 0 });
  // Only the accounts probe runs; signals/buyers/taxonomy short-circuited.
  assert.equal(reads.length, 1);
  assert.equal(batched.length, 0);
});

test("backfillBuyerRoles flushes UPDATEs through DB.batch with stable counts", async () => {
  const buyers = [
    { id: "b1", title: "CTO", role_slug: null, seniority: null, department: null, is_decision_maker: 0 },
    { id: "b2", title: "Head of Engineering", role_slug: null, seniority: null, department: null, is_decision_maker: 0 },
    { id: "b3", title: "Underwater Basket Weaver", role_slug: null, seniority: null, department: null, is_decision_maker: 0 },
  ];
  const taxonomy = [
    { slug: "cto", department: "engineering", seniority: "c_suite", decision_maker: 1, aliases_json: JSON.stringify(["cto", "chief technology officer"]) },
    { slug: "head_of_engineering", department: "engineering", seniority: "head", decision_maker: 1, aliases_json: JSON.stringify(["head of engineering"]) },
  ];
  let directRuns = 0;
  const batched = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          sql, _binds: [],
          bind(...a) { this._binds = a; return this; },
          async all() {
            if (/FROM buyers/.test(sql)) return { results: buyers };
            if (/FROM role_taxonomy/.test(sql)) return { results: taxonomy };
            return { results: [] };
          },
          async run() { directRuns += 1; return { meta: {} }; },
        };
      },
      async batch(stmts) { for (const s of stmts) batched.push({ sql: s.sql, binds: s._binds }); return stmts.map(() => ({})); },
    },
  };
  const r = await backfillBuyerRoles(env, { limit: 1000 });
  assert.equal(r.scanned, 3);
  assert.equal(r.matched, 2);   // CTO + Head of Engineering classify
  assert.equal(r.unmatched, 1); // basket weaver does not
  assert.equal(r.updated, 2);
  // Every UPDATE went through batch(), none as a serial .run().
  assert.equal(batched.length, 2);
  assert.equal(directRuns, 0);
  for (const b of batched) assert.match(b.sql, /UPDATE buyers SET role_slug/);
});

test("cron + orchestrator are wired to the batched paths (source contract)", () => {
  const repo = readFileSync("src/prospects/repo.ts", "utf8");
  assert.match(repo, /export async function recomputeStaleAccountScores/);
  assert.match(repo, /account_id IN \(\$\{idSubquery\}\)/);
  assert.match(repo, /await env\.DB\.batch\(stmts\.slice/);
  // Backfill loop accumulates statements + batches, no per-row .run().
  const backfill = repo.slice(repo.indexOf("export async function backfillBuyerRoles"), repo.indexOf("export async function countUnmatchedBuyerTitles"));
  assert.match(backfill, /updates\.push\(/);
  assert.match(backfill, /await env\.DB\.batch\(updates\.slice/);
  assert.doesNotMatch(backfill, /\.run\(\)/);

  const scheduled = readFileSync("src/scheduled.ts", "utf8");
  assert.match(scheduled, /recomputeStaleAccountScores\(env, 1000\)/);
  assert.match(scheduled, /SELECT \* FROM leads/);
  assert.match(scheduled, /enrichLead\(env, lead\.id, \{ preloadedLead: lead \}\)/);

  const orch = readFileSync("src/enrichment/orchestrator.ts", "utf8");
  assert.match(orch, /opts\.preloadedLead \?\? await repo\.getById/);
});
