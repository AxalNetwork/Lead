// Task #71: error classifier — embedded HTTP status in `fetch_failed:` messages.
//
// The bug: the generic `fetch_failed:` branch returned permanent
// `scrape_blocked` BEFORE the embedded-status branch could recognize a 429
// (rate-limit) or 5xx as transient/retryable, so rate-limited scrape jobs were
// dead-lettered on attempt 1. classify() must now parse the embedded status
// inside the fetch_failed branch: 429 → rate_limited transient, 5xx →
// transient, genuine 4xx / no-status → permanent (unchanged), and the
// dedicated scrape sentinels (robots/tos) stay permanent.

import { test } from "node:test";
import assert from "node:assert/strict";

const { classify } = await import("../test-dist/errors.js");

// ---------- 429 → transient/retryable ----------
test("classify: fetch_failed with embedded 429 is transient + retryable", () => {
  const r = classify("fetch_failed:status_429:status=429");
  assert.ok(r, "classify must recognize the rate-limit error");
  assert.equal(r.kind, "transient");
  assert.equal(r.retryable, true);
  assert.equal(r.code, "rate_limited");
});

test("classify: 429 wins over the generic fetch_failed→permanent rule", () => {
  // The exact production signal from job 8c5884db-...: a fetch_failed: prefix
  // that previously short-circuited to permanent before reaching status logic.
  const r = classify("fetch_failed:status_429:status=429");
  assert.notEqual(r.code, "scrape_blocked");
  assert.equal(r.retryable, true);
});

// ---------- 5xx → transient/retryable ----------
test("classify: fetch_failed with embedded 503 is transient + retryable", () => {
  const r = classify("fetch_failed:status_503:status=503");
  assert.ok(r);
  assert.equal(r.kind, "transient");
  assert.equal(r.retryable, true);
  assert.equal(r.code, "fetch.http_5xx");
});

test("classify: fetch_failed with embedded 500 is transient + retryable", () => {
  const r = classify("fetch_failed:proxy_error:status=500");
  assert.ok(r);
  assert.equal(r.retryable, true);
  assert.equal(r.code, "fetch.http_5xx");
});

// ---------- genuine 4xx → permanent (unchanged) ----------
test("classify: fetch_failed with embedded 403 stays permanent", () => {
  const r = classify("fetch_failed:status_403:status=403");
  assert.ok(r);
  assert.equal(r.kind, "permanent");
  assert.equal(r.retryable, false);
  assert.equal(r.code, "scrape_blocked");
});

test("classify: fetch_failed with embedded 404 stays permanent", () => {
  const r = classify("fetch_failed:status_404:status=404");
  assert.ok(r);
  assert.equal(r.retryable, false);
  assert.equal(r.code, "scrape_blocked");
});

// ---------- no recoverable status → permanent (unchanged) ----------
test("classify: bare fetch_failed:unknown stays permanent", () => {
  const r = classify("fetch_failed:unknown:status=0");
  assert.ok(r);
  assert.equal(r.kind, "permanent");
  assert.equal(r.retryable, false);
  assert.equal(r.code, "scrape_blocked");
});

// ---------- dedicated scrape sentinels remain permanent ----------
test("classify: robots_disallowed stays permanent", () => {
  const r = classify("fetch_failed:robots_disallowed");
  assert.ok(r);
  assert.equal(r.kind, "permanent");
  assert.equal(r.retryable, false);
  assert.equal(r.code, "scrape_blocked");
});

test("classify: tos_blocked stays permanent", () => {
  const r = classify("fetch_failed:tos_blocked");
  assert.ok(r);
  assert.equal(r.kind, "permanent");
  assert.equal(r.retryable, false);
  assert.equal(r.code, "scrape_blocked");
});

// ---------- non-prefix `:fetch_failed:` embedding ----------
test("classify: embedded :fetch_failed: with 429 is transient + retryable", () => {
  const r = classify("profile_fanout:fetch_failed:status_429:status=429");
  assert.ok(r);
  assert.equal(r.retryable, true);
  assert.equal(r.code, "rate_limited");
});

test("classify: embedded :fetch_failed: with 403 stays permanent", () => {
  const r = classify("profile_fanout:fetch_failed:status_403:status=403");
  assert.ok(r);
  assert.equal(r.retryable, false);
  assert.equal(r.code, "scrape_blocked");
});

// ---------- Task #70 regression: subrequest-limit still wins ----------
test("classify: subrequest-limit still classified transient ahead of 4xx", () => {
  const r = classify("fetch_failed:proxy_error:Too many subrequests by single Worker invocation");
  assert.ok(r);
  assert.equal(r.retryable, true);
  assert.equal(r.code, "subrequest_limit");
});
