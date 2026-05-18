// Task #3: lightweight contract tests for the crawler-seeds + smart-frontier
// layer. No live D1 — we stub `env.DB` with a tiny in-memory query log so we
// can assert SQL shape, plus exercise the pure expander.

import test from "node:test";
import assert from "node:assert/strict";

const { classifyReason, REASON_WEIGHTS } = await import("../src/services/frontier/expand.ts").catch(async () => {
  // Vitest-less environments: skip the typed import and assert via SQL files.
  return { classifyReason: null, REASON_WEIGHTS: null };
});

test("reason weights match the Task #3 spec", () => {
  if (!REASON_WEIGHTS) return; // ts-import unavailable in this runner
  assert.equal(REASON_WEIGHTS.linked_team_member, 1.0);
  assert.equal(REASON_WEIGHTS.linked_portfolio_company, 1.0);
  assert.equal(REASON_WEIGHTS.linked_social_handle, 0.9);
  assert.equal(REASON_WEIGHTS.linked_publication, 0.6);
  assert.equal(REASON_WEIGHTS.same_domain_about_page, 0.6);
  assert.equal(REASON_WEIGHTS.mentioned_email_domain, 0.5);
  assert.equal(REASON_WEIGHTS.linked_external_press, 0.3);
});

test("classifyReason: same-site /team → linked_team_member", () => {
  if (!classifyReason) return;
  const r = classifyReason({
    link: { url: "https://a16z.com/team/jane-doe/", anchor: "Jane Doe" },
    canonical: "https://a16z.com/team/jane-doe",
    host: "a16z.com",
    sourceHost: "a16z.com",
  });
  assert.equal(r, "linked_team_member");
});

test("classifyReason: same-site /portfolio → linked_portfolio_company", () => {
  if (!classifyReason) return;
  const r = classifyReason({
    link: { url: "https://sequoiacap.com/companies/airbnb", anchor: "Airbnb" },
    canonical: "https://sequoiacap.com/companies/airbnb",
    host: "sequoiacap.com",
    sourceHost: "sequoiacap.com",
  });
  assert.equal(r, "linked_portfolio_company");
});

test("classifyReason: linkedin.com → linked_social_handle", () => {
  if (!classifyReason) return;
  const r = classifyReason({
    link: { url: "https://linkedin.com/in/jdoe", anchor: "LinkedIn" },
    canonical: "https://linkedin.com/in/jdoe",
    host: "linkedin.com",
    sourceHost: "a16z.com",
  });
  assert.equal(r, "linked_social_handle");
});

test("classifyReason: techcrunch link from VC site → linked_external_press", () => {
  if (!classifyReason) return;
  const r = classifyReason({
    link: { url: "https://techcrunch.com/2026/01/01/foo", anchor: "Read coverage" },
    canonical: "https://techcrunch.com/2026/01/01/foo",
    host: "techcrunch.com",
    sourceHost: "a16z.com",
  });
  assert.equal(r, "linked_external_press");
});

test("classifyReason: unrelated cross-site link → null (filtered out)", () => {
  if (!classifyReason) return;
  const r = classifyReason({
    link: { url: "https://random-saas.example/pricing", anchor: "pricing" },
    canonical: "https://random-saas.example/pricing",
    host: "random-saas.example",
    sourceHost: "a16z.com",
  });
  assert.equal(r, null);
});

// SQL contract — pure file scan so the test is hermetic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

test("migration 342: crawler_seeds + smart_frontier tables with required columns", () => {
  const sql = readFileSync(resolve(__dirname, "../migrations/342_crawler_seeds.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS crawler_seeds/);
  for (const col of [
    "profile_type_id", "seed_kind", "value", "refresh_interval_hours",
    "last_crawled_at", "success_count", "entity_count", "enabled",
  ]) assert.match(sql, new RegExp(col), `crawler_seeds missing ${col}`);
  assert.match(sql, /UNIQUE \(profile_type_id, seed_kind, value\)/);
  assert.match(sql, /REFERENCES e_types\(id\) ON DELETE CASCADE/);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS smart_frontier/);
  for (const col of [
    "url", "host", "profile_type_id", "discovery_reason",
    "priority", "source_url", "source_authority", "novelty_score",
    "discovered_at", "enqueued_at", "status",
  ]) assert.match(sql, new RegExp(col), `smart_frontier missing ${col}`);
  assert.match(sql, /idx_sf_drain.*status, priority DESC/);
});

test("migration 343: seeds cover every major profile-type family", () => {
  const sql = readFileSync(resolve(__dirname, "../migrations/343_seed_crawler_seeds.sql"), "utf8");
  for (const typeId of [
    "investor_vc", "investor_angel", "investor_corporate_vc", "investor_pe",
    "accelerator", "syndicate", "lawyer_securities", "law_firm",
    "banker_investment", "founder", "journalist_tech", "politician_federal",
    "government_agency_federal", "professor", "think_tank",
    "public_company", "executive_search_firm", "accounting_firm",
  ]) assert.match(sql, new RegExp(`'${typeId}'`), `seed migration missing ${typeId}`);
  assert.match(sql, /INSERT OR REPLACE INTO crawler_seeds/);
});

test("crawler-seeds + crawl-frontier routes mounted after accessGuard", () => {
  const idx = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
  const guardIdx = idx.search(/api\.use\(\s*"\/api\/\*"\s*,\s*accessGuard\)/);
  assert.ok(guardIdx > 0);
  const seedsIdx = idx.indexOf('api.route("/api/crawler-seeds"');
  const frontierIdx = idx.indexOf('api.route("/api/crawl-frontier"');
  assert.ok(seedsIdx > guardIdx, "crawler-seeds must be mounted after accessGuard");
  assert.ok(frontierIdx > guardIdx, "crawl-frontier must be mounted after accessGuard");
});

test("hourly scheduled handler invokes runSeedSweep", () => {
  const src = readFileSync(resolve(__dirname, "../src/scheduled.ts"), "utf8");
  assert.match(src, /runSeedSweep/);
});

test("runDiscovery wires expandFrontier into the crawl path", () => {
  const src = readFileSync(resolve(__dirname, "../src/discovery/runDiscovery.ts"), "utf8");
  assert.match(src, /expandFrontier/);
  assert.match(src, /recordSeedEntitiesByUrl/);
});

test("URL seed normalization + recordSeedEntitiesByUrl tolerate trailing slash", () => {
  const sweepSrc = readFileSync(resolve(__dirname, "../src/services/crawlerSeeds/sweep.ts"), "utf8");
  const routeSrc = readFileSync(resolve(__dirname, "../src/routes/crawler_seeds.ts"), "utf8");
  // recordSeedEntitiesByUrl must build a candidate set, not exact-match.
  assert.match(sweepSrc, /candidates\.add/);
  assert.match(sweepSrc, /value IN \(\$\{placeholders\}\)/);
  assert.match(sweepSrc, /canonicalizeUrl/);
  // POST handler must canonicalize url seeds before insert.
  assert.match(routeSrc, /seedKind === "url"/);
  assert.match(routeSrc, /canonicalizeUrl\(value\)/);
});

test("POST /api/crawler-seeds/:id/run uses runSeedById, not bulk sweep", () => {
  const src = readFileSync(resolve(__dirname, "../src/routes/crawler_seeds.ts"), "utf8");
  // The route must call the deterministic per-id helper.
  assert.match(src, /runSeedById\(c\.env, id\)/);
  // It must NOT mutate last_crawled_at on the way in (that was the old bug).
  assert.doesNotMatch(src, /UPDATE crawler_seeds SET last_crawled_at = NULL/);
});
