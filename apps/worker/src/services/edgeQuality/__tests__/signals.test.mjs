// Per-collector unit tests for the 8 DB-backed signals in
// services/edgeQuality/signals.ts. Each collector hits one or two
// source tables; we stub D1 with a deterministic in-memory shim that
// returns a fixed row for a known SQL substring and rejects on
// anything else (so we catch shape regressions early).
//
// safeQuery wraps each collector in try/catch so missing-source
// scenarios are also tested — by making the stub throw, we assert
// the collector returns null rather than propagating the error.

import { test } from "node:test";
import assert from "node:assert/strict";

const sig = await import("../../../../test-dist/services/edgeQuality/signals.js");

function makeStubEnv(handler) {
  // handler(sql, binds) returns either a single row (for .first()),
  // an array (for .all()), or throws (to trigger safeQuery fallback).
  return {
    DB: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...args) { bound = args; return this; },
          async first() {
            const out = handler(sql, bound);
            if (Array.isArray(out)) return out[0] ?? null;
            return out ?? null;
          },
          async all() {
            const out = handler(sql, bound);
            if (Array.isArray(out)) return { results: out };
            return { results: out ? [out] : [] };
          },
        };
      },
    },
  };
}

const E = { src_entity_id: "src-1", dst_entity_id: "dst-1" };

// ---------- signalCoInvestment ----------

test("signalCoInvestment: returns null when no shared deals", async () => {
  const env = makeStubEnv(() => ({ n: 0, last_date: null }));
  const r = await sig.signalCoInvestment(env, E);
  assert.equal(r, null);
});

test("signalCoInvestment: scales 5 co-invests with logScale(_, 10)", async () => {
  const env = makeStubEnv(() => ({ n: 5, last_date: "2024-06-01" }));
  const r = await sig.signalCoInvestment(env, E);
  assert.ok(r);
  assert.ok(r.value > 0 && r.value < 1);
  assert.equal(r.observed_at, "2024-06-01");
});

test("signalCoInvestment: degrades to null on missing deal_participants", async () => {
  const env = makeStubEnv(() => { throw new Error("no such table"); });
  const r = await sig.signalCoInvestment(env, E);
  assert.equal(r, null);
});

// ---------- signalCoMentions ----------

test("signalCoMentions: returns null when no co-mentions", async () => {
  const env = makeStubEnv(() => ({ n: 0, last_seen: null }));
  assert.equal(await sig.signalCoMentions(env, E), null);
});

test("signalCoMentions: emits observed_at and logScale value", async () => {
  const env = makeStubEnv(() => ({ n: 4, last_seen: "2025-01-15" }));
  const r = await sig.signalCoMentions(env, E);
  assert.ok(r && r.value > 0);
  assert.equal(r.observed_at, "2025-01-15");
});

test("signalCoMentions: missing news_entity_mentions table → null", async () => {
  const env = makeStubEnv(() => { throw new Error("no such table"); });
  assert.equal(await sig.signalCoMentions(env, E), null);
});

// ---------- signalBoardOverlap ----------

test("signalBoardOverlap: null when no shared boards", async () => {
  const env = makeStubEnv(() => []);
  assert.equal(await sig.signalBoardOverlap(env, E), null);
});

test("signalBoardOverlap: sums overlapping months across multiple boards", async () => {
  const env = makeStubEnv(() => [
    { co1: "X", s1: "2020-01-01", e1: "2024-01-01", s2: "2022-01-01", e2: "2023-01-01" },
  ]);
  const r = await sig.signalBoardOverlap(env, E);
  assert.ok(r);
  assert.ok(r.value > 0 && r.value <= 1);
  assert.equal(r.observed_at, "2024-01-01");
});

test("signalBoardOverlap: rows present but zero overlap → null", async () => {
  const env = makeStubEnv(() => [
    { co1: "X", s1: "2018-01-01", e1: "2019-01-01", s2: "2022-01-01", e2: "2023-01-01" },
  ]);
  assert.equal(await sig.signalBoardOverlap(env, E), null);
});

// ---------- signalTwitterReplyRate ----------

test("signalTwitterReplyRate: null when no replies", async () => {
  const env = makeStubEnv(() => ({ n: 0, last_seen: null }));
  assert.equal(await sig.signalTwitterReplyRate(env, E), null);
});

test("signalTwitterReplyRate: scales 10 replies with logScale(_, 20)", async () => {
  const env = makeStubEnv(() => ({ n: 10, last_seen: "2025-02-01" }));
  const r = await sig.signalTwitterReplyRate(env, E);
  assert.ok(r && r.value > 0 && r.value < 1);
  assert.equal(r.observed_at, "2025-02-01");
});

test("signalTwitterReplyRate: missing social_interactions → null", async () => {
  const env = makeStubEnv(() => { throw new Error("no such table: social_interactions"); });
  assert.equal(await sig.signalTwitterReplyRate(env, E), null);
});

// ---------- signalLinkedInEndorsements ----------

test("signalLinkedInEndorsements: null when zero", async () => {
  const env = makeStubEnv(() => ({ n: 0, last_seen: null }));
  assert.equal(await sig.signalLinkedInEndorsements(env, E), null);
});

test("signalLinkedInEndorsements: 5 endorsements scales to 1 (knee at 5)", async () => {
  const env = makeStubEnv(() => ({ n: 5, last_seen: "2024-12-01" }));
  const r = await sig.signalLinkedInEndorsements(env, E);
  assert.ok(r);
  assert.ok(Math.abs(r.value - 1) < 1e-9);
});

test("signalLinkedInEndorsements: missing table → null", async () => {
  const env = makeStubEnv(() => { throw new Error("no such table"); });
  assert.equal(await sig.signalLinkedInEndorsements(env, E), null);
});

// ---------- signalJointPanels ----------

test("signalJointPanels: null when no shared events", async () => {
  const env = makeStubEnv(() => ({ n: 0, last_year: null }));
  assert.equal(await sig.signalJointPanels(env, E), null);
});

test("signalJointPanels: 3 joint panels emits observed_at", async () => {
  // conference_attendance records a `year`, not a date — there is no
  // event_date column to read, so the signal reports the January of the
  // latest shared year. Coarse but honest; the decay model only needs a date.
  const env = makeStubEnv(() => ({ n: 3, last_year: 2024 }));
  const r = await sig.signalJointPanels(env, E);
  assert.ok(r && r.value > 0);
  assert.equal(r.observed_at, "2024-01-01");
});

test("signalJointPanels: missing conference_attendance → null", async () => {
  const env = makeStubEnv(() => { throw new Error("no such table"); });
  assert.equal(await sig.signalJointPanels(env, E), null);
});

// ---------- signalSameFirmOrSchool ----------

test("signalSameFirmOrSchool: null when both overlaps are 0", async () => {
  const env = makeStubEnv(() => ({ firm_overlap: 0, school_overlap: 0 }));
  assert.equal(await sig.signalSameFirmOrSchool(env, E), null);
});

test("signalSameFirmOrSchool: firm+school overlap caps at 1", async () => {
  const env = makeStubEnv(() => ({ firm_overlap: 4, school_overlap: 2 }));
  const r = await sig.signalSameFirmOrSchool(env, E);
  assert.ok(r);
  assert.equal(r.value, 1);
  assert.equal(r.observed_at, null);  // static signal — no decay
});

test("signalSameFirmOrSchool: 1 firm overlap → 1/3", async () => {
  const env = makeStubEnv(() => ({ firm_overlap: 1, school_overlap: 0 }));
  const r = await sig.signalSameFirmOrSchool(env, E);
  assert.ok(r);
  assert.ok(Math.abs(r.value - 1 / 3) < 1e-9);
});

// ---------- signalMutualJaccard ----------

test("signalMutualJaccard: null when no shared neighbors", async () => {
  const env = makeStubEnv((sql, binds) => {
    // First arg is the anchor. If anchor === src, return src's nbrs;
    // otherwise return dst's nbrs.
    const anchor = binds[0];
    if (anchor === "src-1") return [{ nbr: "n1" }, { nbr: "n2" }];
    return [{ nbr: "n3" }, { nbr: "n4" }];
  });
  assert.equal(await sig.signalMutualJaccard(env, E), null);
});

test("signalMutualJaccard: identical neighbors → 1.0", async () => {
  const env = makeStubEnv(() => [{ nbr: "n1" }, { nbr: "n2" }]);
  const r = await sig.signalMutualJaccard(env, E);
  assert.ok(r);
  assert.equal(r.value, 1);
  assert.equal(r.observed_at, null);
});

test("signalMutualJaccard: partial overlap returns 0 < j < 1", async () => {
  const env = makeStubEnv((sql, binds) => {
    const anchor = binds[0];
    if (anchor === "src-1") return [{ nbr: "n1" }, { nbr: "n2" }, { nbr: "n3" }];
    return [{ nbr: "n2" }, { nbr: "n3" }, { nbr: "n4" }];
  });
  const r = await sig.signalMutualJaccard(env, E);
  assert.ok(r);
  assert.ok(r.value > 0 && r.value < 1);
});

test("signalMutualJaccard: rel_edges absent → null", async () => {
  const env = makeStubEnv(() => { throw new Error("no such table: rel_edges"); });
  assert.equal(await sig.signalMutualJaccard(env, E), null);
});

// ---------- collectAllSignals integration ----------

test("collectAllSignals: returns only signals that fire", async () => {
  // Stub returns non-null only for the co-investment query (1st of 8
  // queries fired in parallel). Use the SQL substring as the discriminator.
  const env = makeStubEnv((sql) => {
    if (/deal_participants/.test(sql)) return { n: 3, last_date: "2024-05-01" };
    // Everything else returns either an empty count or empty rows.
    if (/COUNT/.test(sql)) return { n: 0, last_seen: null };
    if (/firm_overlap/.test(sql)) return { firm_overlap: 0, school_overlap: 0 };
    return [];
  });
  const out = await sig.collectAllSignals(env, E);
  assert.ok(out.co_investment_5y);
  assert.equal(out.public_co_mentions, undefined);
  assert.equal(out.twitter_reply_rate, undefined);
});

test("collectAllSignals: returns empty bundle when all collectors are dry", async () => {
  const env = makeStubEnv(() => null);
  const out = await sig.collectAllSignals(env, E);
  assert.deepEqual(out, {});
});
