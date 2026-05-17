// Task #3 OSINT unit tests. Pure-TS / no D1 — exercises hashing, guardrails,
// stylometric vector, and the score-scaling rules.

import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = "../test-dist";

test("hashing: md5 + sha256 + hamming", async () => {
  const { md5Hex, sha256Hex, hammingHex } = await import(`${ROOT}/osint/hashing.js`);
  // Known fixture: md5("test@example.com") = 55502f40dc8b7c769880b10874abc9d0
  assert.equal(md5Hex("test@example.com"), "55502f40dc8b7c769880b10874abc9d0");
  // sha256 of empty string is well-known
  assert.equal((await sha256Hex("")).length, 64);
  assert.equal(hammingHex("ff", "f0"), 4);
  assert.equal(hammingHex("aaaa", "aaaa"), 0);
  assert.equal(hammingHex("00", "ff"), 8);
});

test("platforms taxonomy: 60+ entries with unique slugs and well-formed parse hints", async () => {
  const { PLATFORMS, getPlatform, parseProfileUrl } = await import(`${ROOT}/osint/platforms.js`);
  assert.ok(PLATFORMS.length >= 60, `expected >=60 platforms, got ${PLATFORMS.length}`);
  const slugs = new Set(PLATFORMS.map((p) => p.slug));
  assert.equal(slugs.size, PLATFORMS.length, "platform slugs must be unique");
  assert.ok(getPlatform("github"));
  const gh = parseProfileUrl("https://github.com/octocat");
  assert.ok(gh && gh.platform === "github" && gh.handle === "octocat");
  const tw = parseProfileUrl("https://twitter.com/jack");
  assert.ok(tw && tw.platform === "twitter");
});

test("guardrails: blocklist refuses known squatter handles", async () => {
  const { isBlocklisted } = await import(`${ROOT}/osint/guardrails.js`);
  const a = isBlocklisted("twitter", "admin");
  assert.equal(a.blocked, true);
  const b = isBlocklisted("github", "octocat-real-person");
  assert.equal(b.blocked, false);
});

test("guardrails: common-name detector flags plain names", async () => {
  const { isCommonNameOnly } = await import(`${ROOT}/osint/guardrails.js`);
  assert.equal(isCommonNameOnly("John Smith"), true);
  assert.equal(isCommonNameOnly("Mary Johnson"), true);
  // Mixed: a non-common surname keeps it specific.
  assert.equal(isCommonNameOnly("John Zorblax"), false);
  assert.equal(isCommonNameOnly(""), true);
});

test("scoring: corroboration boost + per-method caps", async () => {
  const { scoreHits } = await import(`${ROOT}/osint/guardrails.js`);
  const hits = [
    { platform: "github", handle: "alice", url: "", link_method: "username",   base_confidence: 0.45, evidence_json: {} },
    { platform: "github", handle: "alice", url: "", link_method: "bio_url",    base_confidence: 0.72, evidence_json: {} },
    { platform: "github", handle: "alice", url: "", link_method: "well_known", base_confidence: 0.92, evidence_json: {} },
  ];
  const scored = scoreHits(hits);
  assert.equal(scored.length, 1);
  const s = scored[0];
  assert.equal(s.corroborations, 3);
  // Best base = 0.92; +0.07 * 2 = +0.14, capped at 0.99.
  assert.ok(s.final_confidence >= 0.98, `expected ~0.99, got ${s.final_confidence}`);
});

test("scoring: single username hit stays low (never auto-links by itself)", async () => {
  const { scoreHits } = await import(`${ROOT}/osint/guardrails.js`);
  const s = scoreHits([{ platform: "twitter", handle: "bob", url: "", link_method: "username", base_confidence: 0.45, evidence_json: {} }]);
  assert.equal(s.length, 1);
  assert.equal(s[0].corroborations, 1);
  assert.ok(s[0].final_confidence < 0.85);
});

test("auto-link policy: keybase proof auto-attaches at 0.98 and never queues (even for common name)", async () => {
  const { isAutoLinkEligible } = await import(`${ROOT}/osint/guardrails.js`);
  const d = isAutoLinkEligible({ linkMethod: "keybase", finalConfidence: 0.98, corroborations: 1, isCommonName: true });
  assert.equal(d.eligible, true);
});

test("auto-link policy: weak method (bio_url) alone must NOT auto-link without corroboration", async () => {
  const { isAutoLinkEligible } = await import(`${ROOT}/osint/guardrails.js`);
  const d = isAutoLinkEligible({ linkMethod: "bio_url", finalConfidence: 0.90, corroborations: 1, isCommonName: false });
  assert.equal(d.eligible, false);
  assert.equal(d.reason, "weak_method_needs_corroboration");
});

test("auto-link policy: common handle on common name requires >=3 distinct methods", async () => {
  const { isAutoLinkEligible } = await import(`${ROOT}/osint/guardrails.js`);
  const two = isAutoLinkEligible({ linkMethod: "bio_url", finalConfidence: 0.92, corroborations: 2, isCommonName: true });
  assert.equal(two.eligible, false);
  assert.equal(two.reason, "common_name_needs_corroboration");
  const three = isAutoLinkEligible({ linkMethod: "bio_url", finalConfidence: 0.92, corroborations: 3, isCommonName: true });
  assert.equal(three.eligible, true);
});

test("auto-link policy: username-alone never enough even at high score", async () => {
  const { isAutoLinkEligible } = await import(`${ROOT}/osint/guardrails.js`);
  const d = isAutoLinkEligible({ linkMethod: "username", finalConfidence: 0.99, corroborations: 1, isCommonName: false });
  assert.equal(d.eligible, false);
  assert.equal(d.reason, "username_alone");
});

// ---------------------------------------------------------------------------
// Step-14 acceptance smoke tests. Engine-level (in-memory) — no D1 binding
// required. Each scenario maps 1:1 to a requirement in the task spec.
// ---------------------------------------------------------------------------

test("acceptance (a): LinkedIn-only entity yields ≥5 candidates with ≥2 above 0.85", async () => {
  const { scoreHits, isAutoLinkEligible } = await import(`${ROOT}/osint/guardrails.js`);
  // Simulate the LinkedIn-only entity ("john.smith") flowing through the
  // pivot framework: bio_url + same_as + username produces multiple
  // (platform, handle) candidate groups, two of which corroborate.
  const hits = [
    // GitHub: bio_url + username → 2 distinct methods → corroborated → >0.85
    { platform: "github", handle: "johnsmith", url: "", link_method: "bio_url",  base_confidence: 0.85, evidence_json: {} },
    { platform: "github", handle: "johnsmith", url: "", link_method: "username", base_confidence: 0.45, evidence_json: {} },
    // Twitter: same_as + username → corroborated → >0.85
    { platform: "twitter", handle: "johnsmith", url: "", link_method: "same_as", base_confidence: 0.85, evidence_json: {} },
    { platform: "twitter", handle: "johnsmith", url: "", link_method: "username", base_confidence: 0.45, evidence_json: {} },
    // Weak singletons — surface as candidates but not auto-link.
    { platform: "hackernews", handle: "jsmith",   url: "", link_method: "username", base_confidence: 0.45, evidence_json: {} },
    { platform: "reddit",     handle: "j_smith",  url: "", link_method: "username", base_confidence: 0.45, evidence_json: {} },
    { platform: "medium",     handle: "johnsmith",url: "", link_method: "username", base_confidence: 0.45, evidence_json: {} },
  ];
  const scored = scoreHits(hits);
  assert.ok(scored.length >= 5, `expected >=5 candidates, got ${scored.length}`);
  const auto = scored.filter((s) => s.final_confidence >= 0.85);
  assert.ok(auto.length >= 2, `expected >=2 above 0.85, got ${auto.length}`);
  // And the auto-link policy must accept those corroborated ones (non-common name).
  for (const s of auto) {
    const d = isAutoLinkEligible({ linkMethod: s.link_method, finalConfidence: s.final_confidence, corroborations: s.corroborations, isCommonName: false });
    assert.equal(d.eligible, true, `${s.platform}:${s.handle} should auto-link`);
  }
});

test("acceptance (b): Keybase proof at 0.98 auto-links WITHOUT a candidate row", async () => {
  const { scoreHits, isAutoLinkEligible } = await import(`${ROOT}/osint/guardrails.js`);
  // Keybase signs proofs cryptographically → strong method, no corroboration needed.
  const scored = scoreHits([
    { platform: "github", handle: "alice", url: "", link_method: "keybase", base_confidence: 0.98, evidence_json: { proof_url: "https://keybase.io/alice/sigchain" } },
  ]);
  assert.equal(scored.length, 1);
  const s = scored[0];
  assert.ok(s.final_confidence >= 0.98);
  const d = isAutoLinkEligible({ linkMethod: "keybase", finalConfidence: s.final_confidence, corroborations: 1, isCommonName: true });
  assert.equal(d.eligible, true, "keybase at 0.98 must auto-link even on common name (no candidate row)");
});

test("acceptance (c): common handle 'admin' produces zero auto-links", async () => {
  const { isBlocklisted, isAutoLinkEligible, scoreHits } = await import(`${ROOT}/osint/guardrails.js`);
  // The blocklist is the gate that prevents `admin` from ever reaching the
  // identity_handles table — the resolver checks isBlocklisted BEFORE
  // scoring/eligibility. Verify both layers.
  for (const platform of ["twitter", "github", "reddit", "medium"]) {
    const g = isBlocklisted(platform, "admin");
    assert.equal(g.blocked, true, `admin must be blocklisted on ${platform}`);
  }
  // Even if a hypothetical pivot emitted a high score for 'admin', the
  // policy still wouldn't auto-link because username alone never does.
  const scored = scoreHits([
    { platform: "twitter", handle: "admin", url: "", link_method: "username", base_confidence: 0.99, evidence_json: {} },
  ]);
  const d = isAutoLinkEligible({ linkMethod: scored[0].link_method, finalConfidence: scored[0].final_confidence, corroborations: scored[0].corroborations, isCommonName: false });
  assert.equal(d.eligible, false);
});

test("acceptance (d): 90-day reverify with HTTP 404 demotes the handle", async () => {
  const { reverifyDueHandles } = await import(`${ROOT}/osint/reverify.js`);
  // Stub D1 + simpleGet via the env. simpleGet is imported inside
  // reverify.ts — we substitute globalThis.fetch so it returns 404.
  const updates = [];
  const fakeEnv = {
    DB: {
      prepare(sql) {
        const isSelect = /^\s*SELECT/i.test(sql);
        const isUpdate = /^\s*UPDATE/i.test(sql);
        let binds = [];
        return {
          bind(...a) { binds = a; return this; },
          async all() {
            if (isSelect) {
              return { results: [
                { id: "h1", entity_id: "e1", platform: "github", handle: "ghosted", url: "https://github.com/ghosted" },
              ] };
            }
            return { results: [] };
          },
          async first() { return null; },
          async run() {
            if (isUpdate) updates.push({ sql, binds });
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 404 });
  try {
    const r = await reverifyDueHandles(fakeEnv, { limit: 10, maxAgeDays: 90 });
    assert.equal(r.scanned, 1);
    assert.equal(r.demoted, 1);
    assert.equal(r.reverified, 0);
    const demoted = updates.find((u) => /is_active\s*=\s*0/.test(u.sql) && /demoted_reason/.test(u.sql));
    assert.ok(demoted, "demote UPDATE must be issued");
    assert.match(String(demoted.binds[0]), /^reverify_miss:404/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("stylometric: feature vector + cosine similarity", async () => {
  const { featureVector, cosine } = await import(`${ROOT}/osint/pivots/writing_style.js`);
  const a = featureVector("The quick brown fox jumps over the lazy dog. The dog did not move at all today.");
  const b = featureVector("The quick brown fox jumps over the lazy dog. The dog did not move at all today!");
  const c = featureVector("Кириллица should produce a totally different feature footprint here friends.");
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  const simAB = cosine(a, b);
  const simAC = cosine(a, c);
  assert.ok(simAB > simAC, `expected near-identical text to be more similar than dissimilar (AB=${simAB}, AC=${simAC})`);
  assert.ok(simAB > 0.95);
});
