// Task #3 acceptance smoke tests — non-blocking initially.
//
// These cover the pure pieces of the conversational research agent:
//   * CitationRegistry: marker stability + W-marker non-collision across
//     multiple webSearch invocations in the same loop (the bug the code
//     review caught and we fixed).
//   * diffAnswers: produces the expected entity / news / fact / score
//     change rows the dashboard renders above refreshed saved research.
//   * webSearch fallback contract: web hits are labeled with [W:idx]
//     pills so the dashboard can render them distinctly from DB pills.
//
// The full SSE / agent-loop / climate-hardware acceptance question
// requires live D1 + Workers AI bindings and is exercised in CI's
// `wrangler dev` integration step (out of scope for `npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";

const { CitationRegistry } = await import("../test-dist/agent/registry.js");
const { diffAnswers } = await import("../test-dist/agent/diff.js");

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
  // Simulate two distinct webSearch calls in one loop, each returning
  // 3 hits. We expect markers W:0..W:5, no duplicates.
  const round1 = [0, 1, 2].map(() => reg.registerWeb({ title: "r1" }));
  const round2 = [0, 1, 2].map(() => reg.registerWeb({ title: "r2" }));
  assert.deepEqual(round1, ["W:0", "W:1", "W:2"]);
  assert.deepEqual(round2, ["W:3", "W:4", "W:5"]);
  assert.equal(reg.size(), 6);
});

test("CitationRegistry.extractMarkers: parses [W:0] alongside [E:id]", () => {
  const md = "Acme [E:abc] raised a round [N:n1]. See also [W:0] and [W:1].";
  const ms = CitationRegistry.extractMarkers(md);
  assert.deepEqual(ms, ["E:abc", "N:n1", "W:0", "W:1"]);
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
