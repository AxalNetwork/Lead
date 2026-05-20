// Task #5: unit tests for the Founder CRM pure modules.
//   - reputation collectors (median, speed-to-no, follow-on rate,
//     board behavior, founder NPS, term-aggressiveness percentile)
//   - aggregate + min-sample (>=5) public gate
//   - kanban stage taxonomy + transition rules
//   - anonymity scrub on raw feedback input
//   - public projection redaction below the sample gate
//
// Run with the repo-wide `npm test` script in apps/worker which builds
// the test-dist via tsconfig.test.json and invokes node --test.

import { test } from "node:test";
import assert from "node:assert/strict";

const rep = await import("../../../../test-dist/services/founderCrm/reputation.js");
const stages = await import("../../../../test-dist/services/founderCrm/stages.js");
const anon = await import("../../../../test-dist/services/founderCrm/anonymize.js");
const proj = await import("../../../../test-dist/services/founderCrm/projection.js");
const sug = await import("../../../../test-dist/services/founderCrm/suggestions.js");

// ── suggestions integration ──
//
// Stub D1 env: returns canned rows for each SQL the suggestions module
// issues. We verify (a) excluded-investors filter, (b) ordering by the
// founder-friendly composite, (c) display-name merge, (d) intro_hops
// degrades to null when founderEntityId is null (intro routing never
// runs — Task #14 honest-degradation, never fakes a confidence number).

function stubEnv(tables) {
  return {
    DB: {
      prepare(sql) {
        const s = sql.replace(/\s+/g, " ").trim();
        const binds = [];
        return {
          bind(...args) { binds.push(...args); return this; },
          async all() {
            if (/FROM founder_pipeline_investors/i.test(s)) return { results: tables.existing || [] };
            if (/FROM investor_reputation/i.test(s))       return { results: tables.candidates || [] };
            if (/FROM u_entities/i.test(s))                return { results: tables.entities || [] };
            return { results: [] };
          },
        };
      },
    },
  };
}

test("buildSuggestions: excludes investors already on the pipeline", async () => {
  const env = stubEnv({
    existing:  [{ investor_entity_id: "ent_a" }],
    candidates: [
      { investor_entity_id: "ent_a", follow_on_rate_pct: 0.5, founder_nps: 30, term_aggressiveness_pct: 0.3, sample_size: 6, is_public: 1 },
      { investor_entity_id: "ent_b", follow_on_rate_pct: 0.6, founder_nps: 40, term_aggressiveness_pct: 0.2, sample_size: 7, is_public: 1 },
    ],
    entities: [{ id: "ent_b", display_name: "Fund B" }],
  });
  const out = await sug.buildSuggestions(env, "pipe_1", null, "Series A in fintech", 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].investor_entity_id, "ent_b");
  assert.equal(out[0].display_name, "Fund B");
  // Reputation surfaces; intro routing skipped when founderEntityId=null.
  assert.equal(out[0].reputation.is_public, true);
  assert.equal(out[0].intro_hops, null);
  assert.equal(out[0].intro_predicted_pct, null);
  assert.equal(out[0].ask_match, null);
  assert.equal(out[0].ranking_mode, null);
});

test("buildSuggestions: empty candidate pool returns []", async () => {
  const env = stubEnv({ existing: [], candidates: [], entities: [] });
  const out = await sug.buildSuggestions(env, "pipe_1", "ent_founder", "Series A", 5);
  assert.deepEqual(out, []);
});

test("buildSuggestions: never fakes intro confidence when no path is found", async () => {
  // founderEntityId provided but intros module call will fail (stub env
  // has no rel_edges table). Per spec, intro_hops/intro_predicted_pct
  // must remain null — the route surfaces "no path" rather than fabricating.
  const env = stubEnv({
    existing: [],
    candidates: [
      { investor_entity_id: "ent_x", follow_on_rate_pct: 0.4, founder_nps: 20, term_aggressiveness_pct: 0.5, sample_size: 8, is_public: 1 },
    ],
    entities: [],
  });
  const out = await sug.buildSuggestions(env, "pipe_1", "ent_founder", "Series B in payments", 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].intro_hops, null);
  assert.equal(out[0].intro_predicted_pct, null);
});

test("buildSuggestions: accepts askContext arity and threads it without throwing", async () => {
  // Contract check: the buildSuggestions signature MUST accept askContext
  // as a positional arg between founderEntityId and limit so the route
  // can pass pipeline.raise_purpose into the Task #4 intro engine.
  // (function.length stops at first default param so we can't assert
  // an exact arity here; we exercise the new positional shape instead.)
  const env = stubEnv({
    existing: [],
    candidates: [
      { investor_entity_id: "ent_q", follow_on_rate_pct: 0.5, founder_nps: 25, term_aggressiveness_pct: 0.3, sample_size: 6, is_public: 1 },
    ],
    entities: [{ id: "ent_q", display_name: "Quartz Ventures" }],
  });
  const out = await sug.buildSuggestions(env, "pipe_1", null, "Series A in climate hardware", 5);
  assert.equal(out.length, 1);
  // Without founder entity, intro routing doesn't run — but the row shape
  // surfaces the new ask_match / ranking_mode fields as nulls.
  assert.ok("ask_match" in out[0]);
  assert.ok("ranking_mode" in out[0]);
});

// ── reputation collectors ──

test("median: empty returns null; odd + even length correct", () => {
  assert.equal(rep.median([]), null);
  assert.equal(rep.median([5]), 5);
  assert.equal(rep.median([3, 1, 2]), 2);
  assert.equal(rep.median([4, 1, 3, 2]), 2.5);
});

test("speedToNo: drops non-finite and negative values", () => {
  const r = rep.speedToNo([10, 20, null, undefined, -1, NaN, 30]);
  assert.equal(r.n, 3);
  assert.equal(r.median, 20);
});

test("followOnRate: zero seeds yields null", () => {
  assert.deepEqual(rep.followOnRate(0, 0), { pct: null, n: 0 });
  assert.deepEqual(rep.followOnRate(4, 2), { pct: 0.5, n: 4 });
  // capped at 1.0 in pathological case
  assert.equal(rep.followOnRate(2, 5).pct, 1);
});

test("founderNps: empty=null; classic promoter/passive/detractor math", () => {
  assert.equal(rep.founderNps([]), null);
  // 4 promoters (>=4), 1 detractor (<=2), 1 passive (==3) → (4-1)/6*100
  const v = rep.founderNps([5, 5, 4, 4, 3, 1]);
  assert.equal(Math.round(v * 100) / 100, 50);
  // all detractors → -100
  assert.equal(rep.founderNps([1, 2, 1, 2]), -100);
});

test("boardBehaviorScore: NPS mapped to 0..1", () => {
  // all passives → nps=0 → score=0.5
  assert.equal(rep.boardBehaviorScore([3, 3, 3]), 0.5);
  // all detractors → nps=-100 → score=0
  assert.equal(rep.boardBehaviorScore([1, 1]), 0);
  assert.equal(rep.boardBehaviorScore([]), null);
});

test("termAggressivenessPercentile: focal vs cohort", () => {
  // focal=0.6 above 3 of 5 peers → 3/5
  assert.equal(rep.termAggressivenessPercentile(0.6, [0.1, 0.3, 0.5, 0.7, 0.9]), 3 / 5);
  // null focal → null
  assert.equal(rep.termAggressivenessPercentile(null, [0.1]), null);
  // empty cohort → null
  assert.equal(rep.termAggressivenessPercentile(0.5, []), null);
});

test("aggregateReputation: min-sample gate at >=5 reviews flips is_public/low_sample", () => {
  const below = rep.aggregateReputation({
    feedbackRatings: [4, 4, 5, 3],          // n=4 < 5
    feedbackSpeedToNo: [12],
    renegedCount: 0,
    seedCompanies: 2,
    followedOn: 1,
    aggressivenessScore: 0.5,
    aggressivenessPeers: [0.1, 0.5, 0.9],
    portfolioConflicts: 0,
  });
  assert.equal(below.sample_size, 4);
  assert.equal(below.is_public, 0);
  assert.equal(below.low_sample, 1);

  const above = rep.aggregateReputation({
    feedbackRatings: [4, 4, 5, 3, 2],       // n=5 — flips public
    feedbackSpeedToNo: [12, 20],
    renegedCount: 1,
    seedCompanies: 4,
    followedOn: 2,
    aggressivenessScore: 0.4,
    aggressivenessPeers: [0.1, 0.5, 0.9, 0.7],
    portfolioConflicts: 2,
  });
  assert.equal(above.sample_size, 5);
  assert.equal(above.is_public, 1);
  assert.equal(above.low_sample, 0);
  assert.equal(above.follow_on_rate_pct, 0.5);
  assert.equal(above.reneged_term_sheets_count, 1);
  assert.equal(above.portfolio_conflict_count, 2);
});

// ── kanban stage rules ──

test("stages: isStage validates the 9-stage taxonomy", () => {
  for (const s of ["not_contacted","intro_requested","first_meeting","diligence","partners_meeting","term_sheet","committed","passed","ghosted"]) {
    assert.ok(stages.isStage(s), s);
  }
  assert.equal(stages.isStage("bogus"), false);
});

test("stages: isLegalTransition rejects no-op same-stage; allows active⇄active; allows terminal reopen", () => {
  assert.equal(stages.isLegalTransition("first_meeting", "first_meeting"), false);
  assert.equal(stages.isLegalTransition("first_meeting", "diligence"), true);
  assert.equal(stages.isLegalTransition("diligence", "first_meeting"), true);   // backwards allowed
  assert.equal(stages.isLegalTransition("term_sheet", "committed"), true);
  // Terminal → active reopen is allowed (caller journals it as a reopen)
  assert.equal(stages.isLegalTransition("passed", "first_meeting"), true);
  // Unknown target stage is rejected.
  assert.equal(stages.isLegalTransition("first_meeting", "fake_stage"), false);
});

// ── anonymity scrub ──

test("scrubText: strips emails, urls, runs whitespace, truncates", () => {
  const out = anon.scrubText("contact me at  founder@example.com  via https://x.com/me   please ");
  assert.equal(out, "contact me at [email] via [url] please");
  assert.equal(anon.scrubText("a".repeat(3000), 50).length, 50);
  assert.equal(anon.scrubText(null), null);
  assert.equal(anon.scrubText(""), null);
});

test("anonymizeFeedback: drops PII fields and bounds rating; returns null on bad input", async () => {
  // Missing investor or email → null
  assert.equal(await anon.anonymizeFeedback({}, "salt"), null);
  assert.equal(await anon.anonymizeFeedback({ investor_entity_id: "ent_1" }, "salt"), null);
  // Out-of-range rating → null
  assert.equal(
    await anon.anonymizeFeedback({ investor_entity_id: "ent_1", submitter_email: "x@y.com", behavior_rating: 99 }, "salt"),
    null,
  );
  // Happy path — PII fields are NOT present on the output
  const res = await anon.anonymizeFeedback({
    investor_entity_id: "ent_1",
    submitter_email: "Founder@Example.com",
    submitter_name: "Real Name",
    company_name: "Acme",
    deal_id: "deal_1",
    behavior_rating: 4,
    raise_year: 2025,
    raise_outcome: "passed",
    terms_summary: "12% liq pref",
    speed_to_no_days: 7,
    free_text: "Reach me at founder@example.com",
  }, "test-salt");
  assert.ok(res);
  assert.equal(res.investor_entity_id, "ent_1");
  assert.equal(res.behavior_rating, 4);
  assert.equal(res.raise_year, 2025);
  assert.equal(res.raise_outcome, "passed");
  assert.equal(res.terms_summary, "12% liq pref");
  assert.equal(res.speed_to_no_days, 7);
  assert.equal(res.free_text, "Reach me at [email]");
  assert.equal(typeof res.submitter_hash, "string");
  assert.equal(res.submitter_hash.length, 64); // sha256 hex
  // PII columns must not exist on the persisted shape.
  assert.equal("submitter_email" in res, false);
  assert.equal("submitter_name" in res, false);
  assert.equal("company_name" in res, false);
  assert.equal("deal_id" in res, false);
});

test("hashSubmitter: same email + investor + year + salt → stable; salt change → different", async () => {
  const a = await anon.hashSubmitter("F@x.com", "ent_1", 2025, "salt-a");
  const b = await anon.hashSubmitter("f@x.com", "ent_1", 2025, "salt-a"); // case-insensitive email
  const c = await anon.hashSubmitter("f@x.com", "ent_1", 2025, "salt-b");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ── public projection ──

test("projectPublicReputation: redacts feedback-derived fields when is_public=0", () => {
  const raw = {
    investor_entity_id: "ent_1",
    speed_to_no_days_median: 14,
    term_aggressiveness_pct: 0.4,
    follow_on_rate_pct: 0.6,
    board_behavior_score: 0.7,
    founder_nps: 25,
    reneged_term_sheets_count: 1,
    portfolio_conflict_count: 2,
    sample_size: 2,
    speed_to_no_n: 2,
    follow_on_n: 4,
    is_public: 0,
    low_sample: 1,
    computed_at: "2026-01-01",
  };
  const out = proj.projectPublicReputation(raw);
  // Per spec, EVERY aggregate is gated by min-sample (>=5) — including
  // SEC-derived term_aggressiveness_pct and follow_on_rate_pct.
  assert.equal(out.speed_to_no_days_median, null);
  assert.equal(out.board_behavior_score, null);
  assert.equal(out.founder_nps, null);
  assert.equal(out.reneged_term_sheets_count, null);
  assert.equal(out.term_aggressiveness_pct, null);
  assert.equal(out.follow_on_rate_pct, null);
  // Metadata + flags surface.
  assert.equal(out.is_public, false);
  assert.equal(out.low_sample, true);
  assert.deepEqual(out.redacted_fields.sort(), [
    "board_behavior_score", "follow_on_rate_pct", "founder_nps",
    "reneged_term_sheets_count", "speed_to_no_days_median", "term_aggressiveness_pct",
  ]);
  // Above the gate everything surfaces.
  const above = proj.projectPublicReputation({ ...raw, sample_size: 5, is_public: 1, low_sample: 0 });
  assert.equal(above.is_public, true);
  assert.equal(above.speed_to_no_days_median, 14);
  assert.equal(above.founder_nps, 25);
  assert.deepEqual(above.redacted_fields, []);
});
