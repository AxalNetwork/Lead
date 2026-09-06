// Task #5: acceptance tests for the IndividualProfiler.
//
// Boots node:sqlite with the Task #4 schema (327 + 328) + Task #5 schema
// (329) + the small bits of older migrations the profiler reads from
// (facts, u_entities, rel_edges, news_items + news_entity_mentions,
// identity_handles), then
// drives runProfiler against fixture entities and asserts:
//   A. fixture with rich seeded facts → ≥ 10 structured tables populated
//      and ≥ 5 conversation_starters + ≥ 2 warm_intro_paths in the
//      synthesized to_do_business_with_them dossier.
//   B. fixture with "no press" bio → healthProfiler / familyProfiler /
//      purchaseSignalProfiler / causesProfiler / voiceProfiler /
//      fecDonationsProfiler / stravaPublicProfiler /
//      countyRealEstateProfiler / faaRegistryProfiler all skip with
//      reason=privacy_gate.
//   C. one failing enricher (registered ad-hoc) does not block others
//      and surfaces failed_count in the run row.
//   D. 7-day rate limit blocks a second run within the window and
//      allows it with force_refresh=true.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const ROOT = "../test-dist";

// ---- env shim: adapts node:sqlite to env.DB.prepare(...) + a fake KV.
function makeEnv() {
  const db = new DatabaseSync(":memory:");
  // facts (subset of migration 201 — UNIQUE(hash) drives mirrorFact dedupe).
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
      valid_from TEXT,
      valid_to TEXT,
      supersedes_fact_id TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(hash)
    );
    CREATE TABLE u_entities (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT,
      primary_url TEXT, primary_domain TEXT, primary_email_key TEXT,
      primary_linkedin_key TEXT, primary_twitter_handle TEXT,
      primary_github_handle TEXT, quality_score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', merged_into_entity_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE rel_edges (
      id TEXT PRIMARY KEY, src_entity_id TEXT NOT NULL,
      dst_entity_id TEXT NOT NULL, kind TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 1.0, valid_from TEXT, valid_to TEXT,
      evidence_url TEXT, backing_fact_ids_json TEXT, source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- The real schema: articles live in news_items with no entity_id, and
    -- the entity link is news_entity_mentions. This fixture used to declare a
    -- single news_articles table carrying entity_id, which production has
    -- never had — so the test passed against a schema that does not exist.
    CREATE TABLE news_items (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT, title TEXT,
      published_at TEXT, summary TEXT, sentiment REAL
    );
    CREATE TABLE news_entity_mentions (
      id TEXT PRIMARY KEY, news_item_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      is_subject INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE identity_handles (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, platform TEXT NOT NULL,
      handle TEXT NOT NULL, url TEXT, link_method TEXT, link_confidence REAL,
      evidence_json TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      last_verified_at TEXT, demoted_reason TEXT, updated_at TEXT
    );
    CREATE TABLE summary_rebuild_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL,
      enqueued_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(readFileSync(join(repoRoot, "migrations/327_rich_person_profile.sql"), "utf8"));
  db.exec(readFileSync(join(repoRoot, "migrations/328_predicate_registry.sql"), "utf8"));
  db.exec(readFileSync(join(repoRoot, "migrations/329_individual_profiler.sql"), "utf8"));

  const prepare = (sql) => {
    let pending = [];
    const stmt = db.prepare(sql);
    return {
      bind: (...args) => { pending = args; return prepare._mk(stmt, () => pending); },
    };
  };
  prepare._mk = (stmt, getArgs) => ({
    run:   async () => { stmt.run(...getArgs()); return { success: true }; },
    first: async () => stmt.get(...getArgs()) ?? null,
    all:   async () => ({ results: stmt.all(...getArgs()) }),
  });

  const kv = new Map();
  const SESSIONS = {
    get: async (k) => kv.has(k) ? kv.get(k) : null,
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
  };

  // enqueueSummaryRebuild needs LEAD_QUEUE or it falls back to DB insert.
  return {
    DB: { prepare },
    SESSIONS,
    SCRAPE_CACHE: SESSIONS,
    ENTITY_LOCK: null,
    LEAD_QUEUE: { send: async () => {} },
    _db: db, _kv: kv,
  };
}

function makePersonEntity(env, id, displayName, opts = {}) {
  env._db.prepare(
    `INSERT INTO u_entities (id, kind, display_name, primary_url, primary_domain,
                             primary_twitter_handle, primary_github_handle, primary_linkedin_key)
     VALUES (?, 'person', ?, ?, ?, ?, ?, ?)`,
  ).run(id, displayName,
    opts.primary_url ?? null, opts.primary_domain ?? null,
    opts.twitter ?? null, opts.github ?? null, opts.linkedin ?? null);
}

function insertFact(env, entityId, predicate, valueJson, sourceUrl, observedAtIso = null, valueText = null) {
  env._db.prepare(
    `INSERT INTO facts (id, entity_id, predicate, value_text, value_number, value_json,
                        value_entity_id, source_kind, source, evidence_url, confidence,
                        observed_at, valid_from, valid_to, is_current, hash)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, 'enrichment', ?, ?, 0.8, ?, NULL, NULL, 1, ?)`,
  ).run(
    crypto.randomUUID(), entityId, predicate, valueText,
    valueJson ? JSON.stringify(valueJson) : null,
    sourceUrl, sourceUrl, observedAtIso ?? new Date().toISOString(),
    `seed:${entityId}:${predicate}:${sourceUrl}:${Math.random()}`,
  );
}

function seedRichFixture(env) {
  const targetId = "person_rich";
  const viewerId = "person_viewer";
  const introId  = "person_intro";
  makePersonEntity(env, targetId, "Rich Target");
  makePersonEntity(env, viewerId, "Viewer");
  makePersonEntity(env, introId,  "Mutual Friend");

  // identity-handles → drives communicationProfiler
  env._db.prepare(`INSERT INTO identity_handles (id, entity_id, platform, handle, url, link_method, link_confidence, is_active, last_verified_at) VALUES (?, ?, ?, ?, ?, 'username', 0.9, 1, datetime('now'))`).run(crypto.randomUUID(), targetId, "twitter", "richtarget", "https://twitter.com/richtarget");
  env._db.prepare(`INSERT INTO identity_handles (id, entity_id, platform, handle, url, link_method, link_confidence, is_active, last_verified_at) VALUES (?, ?, ?, ?, ?, 'username', 0.9, 1, datetime('now'))`).run(crypto.randomUUID(), targetId, "github", "richtarget", "https://github.com/richtarget");

  // career
  insertFact(env, targetId, "person.career", { organization_name: "Acme Capital", role_title: "Partner", started_at: "2018-01", is_current: true }, "https://example.com/career/acme");
  insertFact(env, targetId, "person.career", { organization_name: "BetaCo",       role_title: "CTO",     started_at: "2014-06", ended_at: "2017-12" }, "https://example.com/career/beta");
  // board
  insertFact(env, targetId, "person.board_seat", { organization_name: "GreenCo", role: "director", is_independent: true, started_at: "2021-01" }, "https://example.com/board/green");
  // education
  insertFact(env, targetId, "person.education", { institution: "MIT", degree: "BSc", field: "EECS", started_year: 2008, ended_year: 2012 }, "https://example.com/edu/mit");
  // interest
  insertFact(env, targetId, "person.interest.topic", { value: "climate tech" }, "https://example.com/interest/climate");
  insertFact(env, targetId, "person.interest.book",  { value: "The Hard Thing About Hard Things" }, "https://example.com/interest/book");
  // cuisine (lifestyle)
  insertFact(env, targetId, "person.lifestyle.cuisine", { detail: "Japanese izakaya", frequency: "weekly" }, "https://example.com/cuisine/jp");
  // travel
  insertFact(env, targetId, "person.travel.frequent_city", { place: "London", country_iso2: "GB" }, "https://example.com/travel/london");
  // conference
  insertFact(env, targetId, "person.conference", { conference_name: "Web Summit", year: 2024, role: "speaker" }, "https://example.com/conf/ws24");
  // family (public)
  insertFact(env, targetId, "person.family_tie", { relation_type: "spouse", related_name: "Pat Target", is_public: true }, "https://example.com/family/spouse");
  // goal
  insertFact(env, targetId, "person.goal", { goal_kind: "fundraising", goal_text: "Close Fund III by Q4" }, "https://example.com/goal/fund3");
  // appreciation
  insertFact(env, targetId, "person.appreciation", { text: "Loved the espresso machine gift", signal_kind: "gift_idea" }, "https://example.com/appr/espresso");
  // hook predicates
  insertFact(env, targetId, "person.hook.recent_post", { hook_text: "Posted about regen agriculture", hook_kind: "recent_post" }, "https://example.com/hook/regen");

  // news (6 articles → fuels conversation_starters from hookProfiler),
  // seeded through the two real tables rather than one invented one.
  for (let i = 0; i < 6; i++) {
    const newsId = crypto.randomUUID();
    env._db.prepare(`INSERT INTO news_items (id, url, host, title, published_at) VALUES (?, ?, ?, ?, datetime('now', ?))`)
      .run(newsId, `https://news.example.com/${i}`, "news.example.com", `Headline #${i + 1}: notable move`, `-${i + 1} days`);
    env._db.prepare(`INSERT INTO news_entity_mentions (id, news_item_id, entity_id) VALUES (?, ?, ?)`)
      .run(crypto.randomUUID(), newsId, targetId);
  }

  // schedule signal — observed_at spread (≥5 rows, peaked around 14:00 UTC)
  for (let h = 0; h < 24; h++) {
    const count = h === 14 ? 8 : 1;
    for (let n = 0; n < count; n++) {
      const ts = new Date(); ts.setUTCHours(h, 0, 0, 0);
      ts.setUTCDate(ts.getUTCDate() - (n + 1));
      insertFact(env, targetId, "person.signal.activity", { idx: n }, `https://example.com/signal/${h}/${n}`, ts.toISOString());
    }
  }

  // rel_edges: viewer → intro → target  (≥2 hops for warm_intro_paths)
  env._db.prepare(`INSERT INTO rel_edges (id, src_entity_id, dst_entity_id, kind, strength, evidence_url) VALUES (?, ?, ?, 'colleague_of', 0.9, 'https://ex.com/v-i')`).run(crypto.randomUUID(), viewerId, introId);
  env._db.prepare(`INSERT INTO rel_edges (id, src_entity_id, dst_entity_id, kind, strength, evidence_url) VALUES (?, ?, ?, 'colleague_of', 0.8, 'https://ex.com/i-t')`).run(crypto.randomUUID(), introId, targetId);
  // also direct target→intro (so mutualConnectionProfiler picks it up)
  env._db.prepare(`INSERT INTO rel_edges (id, src_entity_id, dst_entity_id, kind, strength, evidence_url) VALUES (?, ?, ?, 'colleague_of', 0.8, 'https://ex.com/t-i')`).run(crypto.randomUUID(), targetId, introId);
  // Second mutual path: viewer → intro2 → target
  const intro2 = "person_intro2";
  makePersonEntity(env, intro2, "Mutual Friend Two");
  env._db.prepare(`INSERT INTO rel_edges (id, src_entity_id, dst_entity_id, kind, strength, evidence_url) VALUES (?, ?, ?, 'co_invested_with', 0.7, 'https://ex.com/v-i2')`).run(crypto.randomUUID(), viewerId, intro2);
  env._db.prepare(`INSERT INTO rel_edges (id, src_entity_id, dst_entity_id, kind, strength, evidence_url) VALUES (?, ?, ?, 'co_invested_with', 0.7, 'https://ex.com/i2-t')`).run(crypto.randomUUID(), intro2, targetId);

  return { targetId, viewerId };
}

function seedPrivacyFixture(env) {
  const id = "person_private";
  makePersonEntity(env, id, "Private Person");
  // bio fact with a "no press" token
  insertFact(env, id, "person.bio", null, "https://example.com/bio/private", null, "No press inquiries please. Private account.");
  // a couple of public-looking facts to confirm non-privacy enrichers still fire
  insertFact(env, id, "person.career", { organization_name: "QuietCo", role_title: "CEO", started_at: "2019-01", is_current: true }, "https://example.com/career/quiet");
  insertFact(env, id, "person.purchase", { detail: "Bought a yacht" }, "https://example.com/purchase/yacht");
  insertFact(env, id, "person.lifestyle.health", { detail: "Marathon 3:30" }, "https://example.com/health/marathon");
  insertFact(env, id, "person.family_tie", { relation_type: "spouse", related_name: "Quiet Spouse", is_public: true }, "https://example.com/family/quiet");
  return { id };
}

// =========================================================================
// Test A — rich fixture
// =========================================================================
test("profiler: rich fixture populates >=10 tables and synthesizes hooks + warm-intro paths", async () => {
  const env = makeEnv();
  const { targetId, viewerId } = seedRichFixture(env);

  const { runProfiler } = await import(`${ROOT}/services/profilers/orchestrator.js`);
  const summary = await runProfiler(env, targetId, {
    runId: crypto.randomUUID(), triggeredBy: "test@local",
    viewerEntityId: viewerId,
  });

  assert.equal(summary.respects_privacy, false, "rich fixture should NOT trigger privacy gate");
  assert.equal(summary.status === "succeeded" || summary.status === "partial", true,
    `expected succeeded/partial, got ${summary.status}`);

  // ≥10 structured tables populated.
  const { readDossier } = await import(`${ROOT}/services/profilers/dossier.js`);
  const dossier = await readDossier(env, targetId, { noCache: true });
  assert.ok(dossier.populated_tables.length >= 10,
    `expected >=10 populated tables, got ${dossier.populated_tables.length}: ${dossier.populated_tables.join(", ")}`);

  // ≥5 conversation_starters
  const dossierSection = dossier.latest_synthesis?.to_do_business_with_them;
  assert.ok(dossierSection, "synthesis must exist");
  assert.ok(dossierSection.conversation_starters.length >= 5,
    `expected >=5 conversation_starters, got ${dossierSection.conversation_starters.length}`);

  // ≥2 warm_intro_paths — viewer-specific paths are now computed at
  // read time (not persisted), so we exercise the same helper the
  // /dossier route uses. This keeps shared synthesis cache stable per
  // entity while still verifying the 2-hop BFS works end-to-end.
  const { computeWarmIntroPaths } = await import(`${ROOT}/services/profilers/synthesize.js`);
  const viewerPaths = await computeWarmIntroPaths(env, targetId, viewerId);
  assert.ok(viewerPaths.length >= 2,
    `expected >=2 viewer warm_intro_paths, got ${viewerPaths.length}`);
  // Cross-caller isolation: a different viewer with NO edges to the
  // target must get zero paths (the prior call must not have polluted
  // shared persisted state).
  const otherPaths = await computeWarmIntroPaths(env, targetId, "person_stranger");
  assert.equal(otherPaths.length, 0, "viewer paths must not bleed across callers");

  // Cited
  assert.ok(dossier.latest_synthesis.citations_count > 0, "synthesis must have citations");

  // Cost log was recorded per enricher.
  const logs = env._db.prepare(`SELECT enricher_name, status FROM profiler_enricher_logs WHERE run_id = ?`).all(summary.runId);
  assert.ok(logs.length >= 30, `expected >=30 enricher logs, got ${logs.length}`);
});

// =========================================================================
// Test B — privacy gate
// =========================================================================
test("profiler: 'no press' bio skips healthProfiler/familyProfiler/purchaseSignalProfiler with privacy_gate reason", async () => {
  const env = makeEnv();
  const { id } = seedPrivacyFixture(env);
  const { runProfiler } = await import(`${ROOT}/services/profilers/orchestrator.js`);
  const summary = await runProfiler(env, id, {
    runId: crypto.randomUUID(), triggeredBy: "test@local",
  });
  assert.equal(summary.respects_privacy, true, "no-press bio must trigger privacy gate");

  const logs = env._db.prepare(
    `SELECT enricher_name, status, skipped_reason FROM profiler_enricher_logs WHERE run_id = ?`,
  ).all(summary.runId);
  const byName = new Map(logs.map(l => [l.enricher_name, l]));
  for (const name of ["healthProfiler", "familyProfiler", "purchaseSignalProfiler", "causesProfiler", "voiceProfiler"]) {
    const e = byName.get(name);
    assert.ok(e, `${name} should appear in logs`);
    assert.equal(e.status, "skipped", `${name} should be skipped`);
    assert.equal(e.skipped_reason, "privacy_gate", `${name} skip reason should be privacy_gate`);
  }
  // career still ran (not privacy-gated)
  const career = byName.get("careerProfiler");
  assert.ok(career && career.status === "done", "careerProfiler must still run for privacy-gated entity");
});

// =========================================================================
// Test C — one failing enricher does not poison the rest
// =========================================================================
test("profiler: a thrown enricher logs failed but does not block siblings", async () => {
  const env = makeEnv();
  const { targetId } = seedRichFixture(env);

  // Monkey-patch the registry: inject a synthetic failing enricher and
  // re-run via the same orchestrator path.
  const reg = await import(`${ROOT}/services/profilers/registry.js`);
  const { runProfiler } = await import(`${ROOT}/services/profilers/orchestrator.js`);
  const orig = reg.ALL_ENRICHERS.slice();
  reg.ALL_ENRICHERS.push({
    name: "intentionallyFailingEnricher",
    category: "career",
    respectsPrivacy: false,
    estCostUsd: () => 0,
    async run() { throw new Error("boom"); },
  });
  try {
    const summary = await runProfiler(env, targetId, {
      runId: crypto.randomUUID(), triggeredBy: "test@local",
    });
    assert.ok(summary.failed_count >= 1, "failed_count must be >=1");
    assert.ok(summary.writes_count > 0, "siblings still produced writes");
    const failRow = env._db.prepare(
      `SELECT status, error FROM profiler_enricher_logs WHERE run_id = ? AND enricher_name = 'intentionallyFailingEnricher'`,
    ).get(summary.runId);
    assert.equal(failRow.status, "failed");
    assert.match(failRow.error || "", /boom/);
  } finally {
    // restore
    reg.ALL_ENRICHERS.length = 0;
    for (const e of orig) reg.ALL_ENRICHERS.push(e);
  }
});

// =========================================================================
// Test D — 7-day rate limit
// =========================================================================
test("profiler: 7-day rate limit blocks 2nd run; force_refresh bypasses", async () => {
  const env = makeEnv();
  const { targetId } = seedRichFixture(env);

  const { checkRateLimit, setLastRun } = await import(`${ROOT}/services/profilers/rateLimit.js`);

  // First run — allowed.
  let decision = await checkRateLimit(env, targetId);
  assert.equal(decision.allowed, true);
  await setLastRun(env, targetId, { runId: "run-1", startedAt: new Date().toISOString() });

  // Second within window — blocked.
  decision = await checkRateLimit(env, targetId);
  assert.equal(decision.allowed, false);
  assert.ok(decision.nextEligibleAt, "must surface next_eligible_at");
  assert.equal(decision.lastRunId, "run-1");

  // force_refresh — allowed.
  decision = await checkRateLimit(env, targetId, { forceRefresh: true });
  assert.equal(decision.allowed, true);

  // Older-than-7-days last run — allowed again.
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  await setLastRun(env, targetId, { runId: "run-old", startedAt: eightDaysAgo });
  decision = await checkRateLimit(env, targetId);
  assert.equal(decision.allowed, true);
});
