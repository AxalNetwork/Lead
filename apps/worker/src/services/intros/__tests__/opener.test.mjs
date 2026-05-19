import { test } from "node:test";
import assert from "node:assert/strict";

const o = await import("../../../../test-dist/services/intros/opener.js");

function wc(s) { return s.trim().split(/\s+/).length; }

test("clampToWords: passes through short strings", () => {
  assert.equal(o.clampToWords("hi there", 60), "hi there");
});

test("clampToWords: truncates to exactly N words", () => {
  const s = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
  const out = o.clampToWords(s, 60);
  assert.equal(wc(out), 60);
});

test("clampToWords: handles empty/null gracefully", () => {
  assert.equal(o.clampToWords("", 60), "");
});

test("pickSignalPhrase: prefers co_investment over other signals", () => {
  const phrase = o.pickSignalPhrase({
    co_investment_5y: { value: 0.5, observed_at: "2024-06-01" },
    board_overlap: { value: 0.4 },
  });
  assert.ok(phrase);
  assert.ok(/co-invest/.test(phrase));
});

test("pickSignalPhrase: returns null when nothing fires", () => {
  assert.equal(o.pickSignalPhrase(null), null);
  assert.equal(o.pickSignalPhrase({}), null);
  assert.equal(o.pickSignalPhrase({ co_investment_5y: { value: 0 } }), null);
});

test("templateOpener: ≤60 words", () => {
  const out = o.templateOpener({
    viewer_name: "Alice",
    first_hop_name: "Bob",
    target_name: "Carol",
    ask_context: "we're raising a Series A in payments and would love a warm intro to discuss our latest traction numbers and runway",
    edge_signals: { co_investment_5y: { value: 0.5, observed_at: "2024-06-01" } },
  });
  assert.ok(wc(out) <= 60, `got ${wc(out)} words`);
  assert.ok(out.includes("Bob"));
  assert.ok(out.includes("Carol"));
});

test("templateOpener: works with all-null inputs", () => {
  const out = o.templateOpener({
    viewer_name: null,
    first_hop_name: null,
    target_name: null,
    ask_context: "",
    edge_signals: null,
  });
  assert.ok(wc(out) <= 60);
  assert.ok(out.length > 0);
});

test("draftOpener: with no OPENAI_API_KEY falls back to template", async () => {
  const out = await o.draftOpener({}, {
    viewer_name: "Alice",
    first_hop_name: "Bob",
    target_name: "Carol",
    ask_context: "intro request",
    edge_signals: null,
  });
  assert.ok(wc(out) <= 60);
  assert.ok(out.includes("Bob"));
});

test("draftOpener: LLM HTTP error falls back to template", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  try {
    const out = await o.draftOpener({ OPENAI_API_KEY: "sk-test" }, {
      viewer_name: "Alice",
      first_hop_name: "Bob",
      target_name: "Carol",
      ask_context: "intro",
      edge_signals: null,
    });
    assert.ok(wc(out) <= 60);
    assert.ok(out.includes("Bob"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("draftOpener: LLM returns >60 words → clamped", async () => {
  const origFetch = globalThis.fetch;
  const longText = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: longText } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const out = await o.draftOpener({ OPENAI_API_KEY: "sk-test" }, {
      viewer_name: "A", first_hop_name: "B", target_name: "C",
      ask_context: "intro", edge_signals: null,
    });
    assert.equal(wc(out), 60);
  } finally {
    globalThis.fetch = origFetch;
  }
});
