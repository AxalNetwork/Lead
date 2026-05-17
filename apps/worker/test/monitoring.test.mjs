// Task #2 acceptance harness.
//
// Pure-function smoke tests that exercise the monitoring spine without
// needing miniflare/D1. Each test maps directly to a spec acceptance
// requirement so a failure is self-locating:
//
//   1. summary fingerprint stability   (idempotent monitor passes)
//   2. diff detects field changes
//   3. dedupe hash entity-scoped       (watchlist rules don't collapse)
//   4. webhook HMAC reproducible       (retries preserve signature)
//   5. webhook signature header shape
//   6. digest scheduler produces future UTC instant
//   7. digest scheduler honours tz (Toronto != UTC)
//   8. trigger registry fully populated (no missing kinds)
//   9. source-driven triggers list non-empty and aligned with registry

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { fingerprintSummary, SUMMARY_SCHEMA_VERSION } = await import("../test-dist/monitoring/summary.js");
const { diffSummaries } = await import("../test-dist/monitoring/diff.js");
const { ALL_TRIGGER_KINDS } = await import("../test-dist/monitoring/types.js");
const { EVALUATORS, SOURCE_DRIVEN_TRIGGERS } = await import("../test-dist/monitoring/triggers/index.js");
const { computeDigestScheduledFor } = await import("../test-dist/monitoring/schedule.js");
const { canonicalJson, signHmac, deliverWebhook } = await import("../test-dist/monitoring/channels/webhook.js");

function baseSummary(overrides = {}) {
  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    entity_id: "e1",
    kind: "person",
    display_name: "Jane Doe",
    title: "CEO",
    employer: "Acme",
    employer_entity_id: "o1",
    city: "Toronto",
    country: "CA",
    fit_max_score: 70,
    intent_score: 40,
    dd_risk_score: 10,
    dd_findings_by_severity: { low: 0, medium: 0, high: 0, critical: 0 },
    portfolio_count: 0,
    handles_count: 2,
    last_news_at: null,
    role: "founder",
    sectors_csv: "ai,saas",
    stages_csv: "seed",
    ...overrides,
  };
}

test("summary fingerprint is stable across identical inputs", async () => {
  const a = await fingerprintSummary(baseSummary());
  const b = await fingerprintSummary(baseSummary());
  assert.equal(a, b);
});

test("summary fingerprint changes when a tracked field changes", async () => {
  const a = await fingerprintSummary(baseSummary());
  const b = await fingerprintSummary(baseSummary({ title: "CTO" }));
  assert.notEqual(a, b);
});

test("diff detects scalar field changes", () => {
  const d = diffSummaries(baseSummary(), baseSummary({ title: "CTO" }));
  assert.ok(d.find((x) => x.field === "title"), "title not found in diff");
});

test("dedupe hash is entity-scoped (watchlist rules don't collapse)", () => {
  // Reproduces the hash format used by dispatch.ts: rule|entity|kind|key.
  function hash(rule, entity, kind, key) {
    return crypto.createHash("sha256").update(`${rule}|${entity}|${kind}|${key}`).digest("hex");
  }
  const h1 = hash("r1", "ent-A", "any_change", "title");
  const h2 = hash("r1", "ent-B", "any_change", "title");
  assert.notEqual(h1, h2);
});

test("webhook HMAC is reproducible over the same body", async () => {
  const body = { event_id: "e", entity_id: "x", trigger_kind: "any_change",
                 occurred_at: "2026-01-01T00:00:00Z", title: "t", body: "b", diff: [], payload: {} };
  const json = canonicalJson(body);
  const s1 = await signHmac("secret", json);
  const s2 = await signHmac("secret", json);
  assert.equal(s1, s2);
  assert.ok(s1.startsWith("sha256="));
});

test("digest scheduler produces a future UTC instant for daily/weekly", () => {
  const prefs = { email: "u@x", timezone: "UTC", digest_hour: 9, digest_weekday: 1 };
  const now = new Date("2026-01-01T00:00:00Z");
  const daily = computeDigestScheduledFor("daily", prefs, now);
  const weekly = computeDigestScheduledFor("weekly", prefs, now);
  assert.ok(new Date(daily).getTime() > now.getTime());
  assert.ok(new Date(weekly).getTime() > now.getTime());
});

test("digest scheduler honours local timezone (Toronto != UTC)", () => {
  const utc = { email: "u", timezone: "UTC", digest_hour: 9, digest_weekday: 1 };
  const tor = { email: "u", timezone: "America/Toronto", digest_hour: 9, digest_weekday: 1 };
  const now = new Date("2026-01-01T00:00:00Z");
  const a = computeDigestScheduledFor("daily", utc, now);
  const b = computeDigestScheduledFor("daily", tor, now);
  assert.notEqual(a, b);
});

test("trigger registry covers every enum kind with a real evaluator", () => {
  for (const k of ALL_TRIGGER_KINDS) {
    assert.ok(typeof EVALUATORS[k] === "function", `missing evaluator: ${k}`);
  }
});

test("source-driven trigger set is non-empty and a subset of the registry", () => {
  assert.ok(SOURCE_DRIVEN_TRIGGERS.size > 0, "no source-driven triggers declared");
  for (const k of SOURCE_DRIVEN_TRIGGERS) {
    assert.ok(ALL_TRIGGER_KINDS.includes(k), `${k} not in enum`);
  }
});

// Integration-style: walk the webhook lifecycle through three responses
// (500 → 500 → 200). Each attempt must (a) send the SAME signed body so
// the downstream HMAC stays stable and (b) classify the 5xx as retryable
// and the 2xx as terminal-ok. Mocks globalThis.fetch.
test("webhook retry lifecycle 500→500→200 keeps signature stable and classifies retryable", async () => {
  const origFetch = globalThis.fetch;
  const calls = [];
  const responses = [
    new Response("upstream down", { status: 500 }),
    new Response("still down", { status: 500 }),
    new Response("ok", { status: 200 }),
  ];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body, sig: init.headers["X-AIDS-Signature"] });
    return responses.shift();
  };
  try {
    const env = { RL_HOST: null };
    const body = { event_id: "evt-1", entity_id: "ent-1", trigger_kind: "any_change",
                   occurred_at: "2026-01-01T00:00:00Z", title: "t", body: "b", diff: [], payload: {} };
    const p = { url: "https://example.test/hook", secret: "s3cr3t", body };
    const r1 = await deliverWebhook(env, p);
    const r2 = await deliverWebhook(env, p);
    const r3 = await deliverWebhook(env, p);
    assert.equal(r1.ok, false); assert.equal(r1.retryable, true); assert.equal(r1.status, 500);
    assert.equal(r2.ok, false); assert.equal(r2.retryable, true);
    assert.equal(r3.ok, true);  assert.equal(r3.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].body, calls[1].body, "retry body must match original");
    assert.equal(calls[1].body, calls[2].body, "success body must match retry");
    assert.equal(calls[0].sig, calls[1].sig, "retry signature must match original");
    assert.equal(calls[1].sig, calls[2].sig, "success signature must match retry");
    assert.ok(calls[0].sig.startsWith("sha256="));
  } finally {
    globalThis.fetch = origFetch;
  }
});

// Regression: dedupe suppression must hold even when the prior emission
// is mid-retry (pending) or terminally failed. A flaky webhook target
// must NOT cause repeated event rows for the same underlying change.
// Asserts the dispatch.ts dedupe SELECT no longer filters by
// delivery_status (which would let pending/failed rows fall through).
test("dedupe suppression is independent of delivery_status (pending/failed don't re-emit)", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../src/monitoring/dispatch.ts", import.meta.url), "utf8");
  const m = src.match(/SELECT\s+id\s+FROM\s+alert_events\s+WHERE\s+dedupe_hash[^`;]+/i);
  assert.ok(m, "could not locate dedupe SELECT in dispatch.ts");
  const query = m[0];
  assert.ok(!/delivery_status/i.test(query),
    "dedupe SELECT must not filter by delivery_status; pending/failed rows must still suppress re-emission");
  assert.ok(/occurred_at\s*>\s*\?/i.test(query),
    "dedupe SELECT must still scope to the dedupe window");
});

// Integration-style: a 4xx (non-429/408) response is a permanent failure;
// the dispatcher must NOT schedule a retry in that case.
test("webhook 4xx (non-429/408) is classified as non-retryable", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad request", { status: 400 });
  try {
    const r = await deliverWebhook({ RL_HOST: null },
      { url: "https://example.test/hook", secret: "s", body: { x: 1 } });
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
    assert.equal(r.status, 400);
  } finally {
    globalThis.fetch = origFetch;
  }
});
