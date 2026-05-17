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
