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
// The full SSE / agent-loop / climate-hardware acceptance question
// requires live D1 + Workers AI bindings and is exercised in CI's
// `wrangler dev` integration step (out of scope for `npm test`).

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
