import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize, keyTokens, jaccard, verifySourceSpan,
} from "../../../../test-dist/services/mlOps/verifier.js";

test("normalize: strips punctuation + lowercases + collapses spaces", () => {
  assert.equal(normalize("Hello,  World!"), "hello world");
});

test("keyTokens: drops stopwords + short tokens", () => {
  assert.deepEqual(keyTokens("The CEO of Acme"), ["ceo", "acme"]);
});

test("jaccard: identical sets → 1; disjoint → 0", () => {
  assert.equal(jaccard(["a", "b"], ["a", "b"]), 1);
  assert.equal(jaccard(["a"], ["b"]), 0);
});

test("verify: empty span → empty_span", () => {
  const r = verifySourceSpan({ claim_text: "foo", source_span: "", source_text: "foo bar" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_span");
});

test("verify: span literally in source AND contains claim → ok", () => {
  const r = verifySourceSpan({
    claim_text: "Acme raised $10M",
    source_span: "Acme Inc raised $10M Series A from Foo",
    source_text: "TechCrunch: Acme Inc raised $10M Series A from Foo Ventures today.",
  });
  assert.equal(r.ok, true);
});

test("verify: span not in source → span_not_in_source", () => {
  const r = verifySourceSpan({
    claim_text: "Acme raised $10M",
    source_span: "Beta raised $99M Series C from Bar",
    source_text: "TechCrunch: Acme Inc raised $10M Series A from Foo Ventures today.",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "span_not_in_source");
});

test("verify: claim tokens NOT in span (fabricated) → low_fuzzy or claim_not_in_span", () => {
  const r = verifySourceSpan({
    claim_text: "company headquartered in Tokyo Japan island",
    source_span: "Acme Inc raised funding today",
    source_text: "Acme Inc raised funding today",
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason === "low_fuzzy" || r.reason === "claim_not_in_span");
});

test("verify: fuzzy ≥0.7 → ok", () => {
  // claim tokens nearly equal to span tokens
  const r = verifySourceSpan({
    claim_text: "Acme raised ten million",
    source_span: "Acme raised ten million dollars",
    source_text: "Acme raised ten million dollars in Series A",
  });
  assert.equal(r.ok, true);
});
