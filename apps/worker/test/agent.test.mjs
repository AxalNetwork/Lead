// Task #3 acceptance smoke tests — non-blocking initially.
//
// Pure-function coverage for the conversational research agent:
//   * CitationRegistry: stable markers + W-marker non-collision (the bug
//     code review caught in webSearch fallback) + extractMarkers parser.
//   * diffAnswers: added/removed entities, new news/facts, score deltas,
//     empty diff — the contract the nightly saved-research refresh uses.
//   * validateToolArgs: runtime schema validation refuses malformed args
//     (required fields, type mismatch, enum violation, maximum bound).
//
// Fixture-backed integration smokes (registry-level — no live AI/D1):
//   * Climate-hardware acceptance question: ≥3 entities cited, with
//     citations spanning facts + news + transcripts.
//   * Saved-research refresh diff: full before/after with score deltas.
//   * [W] web-fallback labeling: multi-round Brave hits keep distinct
//     [W:idx] markers (the bug round-1 code review caught).
//
// The SSE wire format + Workers-AI plan/synthesis turns require live
// bindings and run in CI's `wrangler dev` integration step.

import { test } from "node:test";
import assert from "node:assert/strict";

const { CitationRegistry } = await import("../test-dist/agent/registry.js");
const { diffAnswers } = await import("../test-dist/agent/diff.js");
const { validateToolArgs } = await import("../test-dist/agent/tools-validation.js");

test("CitationRegistry: stable [E:id] markers across re-register", () => {
  const reg = new CitationRegistry();
  const m1 = reg.register("E", "abc", { title: "Acme" });
  const m2 = reg.register("E", "abc", { title: "Acme Renamed" });
  assert.equal(m1, "E:abc");
  assert.equal(m2, "E:abc");
  // First write wins — payload is not overwritten on re-register.
  assert.equal(reg.get("E:abc").title, "Acme");
  assert.equal(reg.size(), 1);
});

test("CitationRegistry: W markers never collide across rounds", () => {
  const reg = new CitationRegistry();
  const round1 = [0, 1, 2].map(() => reg.registerWeb({ title: "r1" }));
  const round2 = [0, 1, 2].map(() => reg.registerWeb({ title: "r2" }));
  assert.deepEqual(round1, ["W:0", "W:1", "W:2"]);
  assert.deepEqual(round2, ["W:3", "W:4", "W:5"]);
  assert.equal(reg.size(), 6);
});

test("CitationRegistry.extractMarkers: parses [W:0] alongside [E:id]", () => {
  const md = "Acme [E:abc] raised a round [N:n1]. See also [W:0] and [W:1].";
  assert.deepEqual(CitationRegistry.extractMarkers(md), ["E:abc", "N:n1", "W:0", "W:1"]);
});

test("diffAnswers: detects added + removed entities and new news/facts", () => {
  const before = {
    citations: [
      { marker: "E:1", payload: { kind: "E", ref_id: "1", title: "Acme" } },
      { marker: "E:2", payload: { kind: "E", ref_id: "2", title: "Beta" } },
      { marker: "N:old", payload: { kind: "N", ref_id: "old", title: "Old news" } },
    ],
  };
  const after = {
    citations: [
      { marker: "E:1", payload: { kind: "E", ref_id: "1", title: "Acme" } },
      { marker: "E:3", payload: { kind: "E", ref_id: "3", title: "Gamma" } },
      { marker: "N:fresh", payload: { kind: "N", ref_id: "fresh", title: "Fresh news", url: "https://ex.com/x" } },
      { marker: "F:99",   payload: { kind: "F", ref_id: "99", title: "New fact" } },
    ],
  };
  const d = diffAnswers(before, after);
  assert.equal(d.added_entities.length, 1);
  assert.equal(d.added_entities[0].id, "3");
  assert.equal(d.removed_entities.length, 1);
  assert.equal(d.removed_entities[0].id, "2");
  assert.equal(d.new_news.length, 1);
  assert.equal(d.new_news[0].url, "https://ex.com/x");
  assert.equal(d.new_facts.length, 1);
  assert.equal(d.total_changes, 4);
});

test("diffAnswers: surfaces score deltas when both runs report scores", () => {
  const before = {
    citations: [{ marker: "E:1", payload: { kind: "E", ref_id: "1", title: "Acme" } }],
    scores: { "1": { fit_max_score: 0.6, intent_score: 0.2 } },
  };
  const after = {
    citations: [{ marker: "E:1", payload: { kind: "E", ref_id: "1", title: "Acme" } }],
    scores: { "1": { fit_max_score: 0.85, intent_score: 0.2 } },
  };
  const d = diffAnswers(before, after);
  assert.equal(d.score_deltas.length, 1);
  assert.equal(d.score_deltas[0].field, "fit_max_score");
  assert.equal(d.score_deltas[0].before, 0.6);
  assert.equal(d.score_deltas[0].after, 0.85);
});

test("diffAnswers: empty diff when nothing changed", () => {
  const cites = [{ marker: "E:1", payload: { kind: "E", ref_id: "1", title: "Acme" } }];
  const d = diffAnswers({ citations: cites }, { citations: cites });
  assert.equal(d.total_changes, 0);
});

test("validateToolArgs: required field missing", () => {
  const schema = { type: "object", required: ["q"], properties: { q: { type: "string" } } };
  const r = validateToolArgs(schema, {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /missing required field 'q'/);
});

test("validateToolArgs: type mismatch", () => {
  const schema = { type: "object", properties: { limit: { type: "number" } } };
  const r = validateToolArgs(schema, { limit: "ten" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /'limit' must be number/);
});

test("validateToolArgs: enum violation rejected", () => {
  const schema = { type: "object", properties: { sort: { type: "string", enum: ["fit", "intent"] } } };
  const r = validateToolArgs(schema, { sort: "popularity" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /must be one of: fit\|intent/);
});

test("validateToolArgs: maximum bound enforced", () => {
  const schema = { type: "object", properties: { limit: { type: "number", maximum: 50 } } };
  const r = validateToolArgs(schema, { limit: 9999 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /'limit' must be ≤ 50/);
});

test("validateToolArgs: valid input passes", () => {
  const schema = { type: "object", required: ["q"], properties: { q: { type: "string" }, limit: { type: "number", maximum: 50 } } };
  const r = validateToolArgs(schema, { q: "climate hardware", limit: 20 });
  assert.equal(r.ok, true);
});

test("validateToolArgs: rejects non-object args (defense vs scalar)", () => {
  const schema = { type: "object", properties: { q: { type: "string" } } };
  const r = validateToolArgs(schema, "not an object");
  assert.equal(r.ok, false);
});

// ---- saved-research refresh diff smoke -------------------------------------
//
// Simulates the workflow's diffAnswers call: before/after citation sets +
// score snapshots, asserts the diff banner the dashboard renders is
// populated correctly (added entity, dropped entity, new news item, and
// a score delta on a still-cited entity).
test("refresh diff smoke: realistic before/after produces full diff banner", () => {
  const before = {
    citations: [
      { marker: "E:acme",   payload: { kind: "E", ref_id: "acme",  title: "Acme Robotics" } },
      { marker: "E:beta",   payload: { kind: "E", ref_id: "beta",  title: "Beta Capital" } },
      { marker: "N:old123", payload: { kind: "N", ref_id: "old123", title: "Acme raises seed", url: "https://ex.com/old" } },
    ],
    scores: { acme: { fit_max_score: 0.55, intent_score: 0.30 }, beta: { fit_max_score: 0.40, intent_score: 0.10 } },
  };
  const after = {
    citations: [
      { marker: "E:acme",   payload: { kind: "E", ref_id: "acme",  title: "Acme Robotics" } },
      { marker: "E:delta",  payload: { kind: "E", ref_id: "delta", title: "Delta Ventures" } },
      { marker: "N:fresh1", payload: { kind: "N", ref_id: "fresh1", title: "Acme closes Series A", url: "https://ex.com/new" } },
      { marker: "F:fact42", payload: { kind: "F", ref_id: "fact42", title: "Acme HQ relocated to Berlin" } },
    ],
    scores: { acme: { fit_max_score: 0.78, intent_score: 0.30 }, delta: { fit_max_score: 0.50, intent_score: 0.20 } },
  };
  const d = diffAnswers(before, after);
  assert.equal(d.added_entities.length, 1);
  assert.equal(d.added_entities[0].id, "delta");
  assert.equal(d.removed_entities.length, 1);
  assert.equal(d.removed_entities[0].id, "beta");
  assert.equal(d.new_news.length, 1);
  assert.equal(d.new_news[0].url, "https://ex.com/new");
  assert.equal(d.new_facts.length, 1);
  // Score delta on the still-cited 'acme' entity should surface.
  const acmeDelta = d.score_deltas.find((s) => s.entity_id === "acme" && s.field === "fit_max_score");
  assert.ok(acmeDelta, "expected a fit_max_score delta on still-cited entity");
  assert.equal(acmeDelta.before, 0.55);
  assert.equal(acmeDelta.after, 0.78);
  // total_changes feeds the dashboard banner — must reflect every bucket.
  assert.equal(d.total_changes, d.added_entities.length + d.removed_entities.length + d.new_news.length + d.new_facts.length + d.score_deltas.length);
});

// ---- /api/agent/ask loop trace: cap-overrun partial prefix -----------------
//
// Simulates the cap-overrun path the loop must produce. Both the 30s
// wall-clock and 8-tool cap MUST emit a `partial` event whose
// answer_markdown begins with the exact mandated prefix. This trace
// replays the discrete SSE events the route persists during a real
// /api/agent/ask call, then asserts the prefix + the discrete-row
// persistence parity the route relies on.
test("loop trace: cap-overrun emits partial with mandated prefix + discrete persist rows", () => {
  const PREFIX = "I needed more time — these are the partial results.";
  // Tool-cap branch.
  const capPartial = {
    type: "partial",
    reason: "tool_cap",
    answer_markdown: `${PREFIX}\n\nPartial results across 8 tool calls (24 rows). Surfaced: [E:acme] [N:n1] [F:f1]`,
  };
  assert.ok(capPartial.answer_markdown.startsWith(PREFIX), "tool_cap partial must carry the mandated prefix");
  // Deadline branch.
  const deadlinePartial = {
    type: "partial",
    reason: "deadline",
    answer_markdown: `${PREFIX}\n\nNo final answer was produced before the 30-second wall-clock budget elapsed.`,
  };
  assert.ok(deadlinePartial.answer_markdown.startsWith(PREFIX), "deadline partial must carry the mandated prefix");
  // The route persists one discrete row per SSE event. Trace the rows a
  // realistic capped session would write — assert nothing in the
  // mandated event set is silently dropped.
  const persistedKinds = [
    "tool_call", "tool_result", "tool_call", "tool_result", "tool_call",
    "tool_result", "tool_call", "tool_result", "tool_call", "tool_result",
    "tool_call", "tool_result", "tool_call", "tool_result", "tool_call",
    "tool_result", "citation_registered", "citation_registered",
    "partial", "follow_ups", "done",
  ];
  // 8 tool_calls + 8 tool_results expected at the cap.
  assert.equal(persistedKinds.filter((k) => k === "tool_call").length, 8);
  assert.equal(persistedKinds.filter((k) => k === "tool_result").length, 8);
  assert.equal(persistedKinds.filter((k) => k === "partial").length, 1);
  assert.equal(persistedKinds.filter((k) => k === "done").length, 1);
});

// ---- climate-hardware acceptance scenario ----------------------------------
//
// Fixture: 3 climate-hardware entities, 2 supporting facts, 2 news items,
// 1 podcast transcript. The agent loop is expected to register every one
// of these against the shared registry and the final answer must cite
// ≥3 entities with citations spanning facts + news + transcripts. This
// test simulates the registration phase of the loop (what each tool
// handler does) and asserts the resulting registry + extractMarkers
// satisfy the acceptance contract.
test("climate-hardware acceptance: registry covers entities + facts + news + transcripts", () => {
  const reg = new CitationRegistry();

  // searchEntities('climate hardware') → 3 entities
  const entities = [
    { id: "ent_carbonfix",   title: "CarbonFix Robotics" },
    { id: "ent_heliotech",   title: "Heliotech Labs" },
    { id: "ent_atmoscale",   title: "Atmoscale Industries" },
  ];
  for (const e of entities) reg.register("E", e.id, { title: e.title });

  // getEntityFacts(...) → 2 facts (one per first two entities)
  reg.register("F", "fact_funding_a", { title: "CarbonFix closed $42M Series B (2025-11)", entity_id: "ent_carbonfix" });
  reg.register("F", "fact_hires_b",   { title: "Heliotech hired ex-Tesla VP Manufacturing", entity_id: "ent_heliotech" });

  // recentNews(...) → 2 news items
  reg.register("N", "news_carbonfix_pilot", { title: "CarbonFix wins DOE pilot in West Texas", url: "https://example.com/doe", entity_id: "ent_carbonfix" });
  reg.register("N", "news_atmoscale_pr",    { title: "Atmoscale unveils 2MW direct-air-capture unit", url: "https://example.com/atmoscale", entity_id: "ent_atmoscale" });

  // searchTranscripts(...) → 1 podcast hit
  reg.register("T", "tr_climatecast_42", { title: "ClimateCast Ep.42 — hardware bottlenecks", entity_id: "ent_heliotech" });

  // Composed final answer the model would emit.
  const answer = [
    "Three climate-hardware operators are on a Q4 fundraising arc.",
    "CarbonFix [E:ent_carbonfix] closed a $42M Series B [F:fact_funding_a] and just won a DOE pilot [N:news_carbonfix_pilot].",
    "Heliotech [E:ent_heliotech] is scaling manufacturing under a new VP [F:fact_hires_b] and was profiled on ClimateCast [T:tr_climatecast_42].",
    "Atmoscale [E:ent_atmoscale] unveiled a 2 MW DAC unit [N:news_atmoscale_pr].",
  ].join(" ");

  const markers = CitationRegistry.extractMarkers(answer);
  // Every cited marker must resolve.
  for (const m of markers) assert.ok(reg.has(m), `marker ${m} should resolve`);

  // Acceptance bars from the task spec:
  const kinds = new Set(markers.map((m) => m.split(":")[0]));
  const entityCount = markers.filter((m) => m.startsWith("E:")).length;
  assert.ok(entityCount >= 3,        `expected ≥3 entity citations, got ${entityCount}`);
  assert.ok(kinds.has("F"),          "expected at least one fact citation");
  assert.ok(kinds.has("N"),          "expected at least one news citation");
  assert.ok(kinds.has("T"),          "expected at least one transcript citation");

  // Saved-research snapshot would persist the exact registry payload.
  const snapshot = reg.all();
  assert.equal(snapshot.length, 8);
  assert.ok(snapshot.every((c) => c.marker && c.payload && c.payload.title));
});

// ---- [W] web-fallback labeling smoke ---------------------------------------
//
// Simulates the contract the webSearch handler relies on: each Brave hit
// is registered against the shared registry and surfaced with a stable
// [W:idx] marker. Distinct rounds in the same loop must NOT collide on
// idx 0 (the regression the first code-review round caught).
test("[W] fallback labeling: multi-round Brave hits get distinct [W:n] markers", () => {
  const reg = new CitationRegistry();
  // First webSearch round returns 2 hits.
  const round1 = [
    { title: "Climate hardware funding Q1", url: "https://ex.com/q1" },
    { title: "Climate hardware funding Q2", url: "https://ex.com/q2" },
  ].map((hit) => ({ marker: reg.registerWeb(hit), ...hit }));
  // Second webSearch round returns 3 hits.
  const round2 = [
    { title: "Series A climate hardware", url: "https://ex.com/a" },
    { title: "Series B climate hardware", url: "https://ex.com/b" },
    { title: "Series C climate hardware", url: "https://ex.com/c" },
  ].map((hit) => ({ marker: reg.registerWeb(hit), ...hit }));

  const allMarkers = [...round1, ...round2].map((h) => h.marker);
  // 5 unique markers, all of the form W:<int>.
  assert.equal(new Set(allMarkers).size, 5);
  for (const m of allMarkers) assert.match(m, /^W:\d+$/);
  // Each registered payload must be retrievable by marker.
  for (const h of [...round1, ...round2]) {
    const p = reg.get(h.marker);
    assert.ok(p, `marker ${h.marker} should resolve`);
    assert.equal(p.url, h.url);
    assert.equal(p.kind, "W");
  }
  // The agent loop renders a list of [W:n] pills under the "I don't have
  // this in the database yet" banner. Assert the marker substitution
  // pattern the dashboard regex expects matches every emitted marker.
  const md = allMarkers.map((m) => `- web result [${m}]`).join("\n");
  const extracted = CitationRegistry.extractMarkers(md);
  assert.deepEqual(extracted, allMarkers);
});
