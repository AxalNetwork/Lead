// Task #1: DealExtractor strict-coercion unit tests.
//
// Locks the spec contract: missing or unrecognized event_type causes
// toCandidate() to return null rather than silently defaulting to
// "funding_round" (which would mislabel acquisitions / IPOs / etc).

import { test } from "node:test";
import assert from "node:assert/strict";

const { toCandidate } = await import("../../../test-dist/ai/dealExtractor.js");

const baseInput = {
  source_url: "https://example.com/news/1",
  source_type: "tech_press",
  source_published_at: "2025-05-12T00:00:00.000Z",
};

const baseRaw = {
  event_type: "funding_round",
  company_name: "Acme Corp",
  round_name: "Series B",
  amount_usd: 42_000_000,
  lead_investors: ["Sequoia"],
  participating_investors: [],
  confidence: 0.8,
};

test("toCandidate: well-formed input produces a DealCandidate", () => {
  const out = toCandidate(baseRaw, baseInput);
  assert.ok(out, "should return a candidate");
  assert.equal(out.event_type, "funding_round");
  assert.equal(out.company_name_raw, "Acme Corp");
  assert.equal(out.amount_usd, 42_000_000);
});

test("toCandidate: missing event_type returns null (no silent funding_round default)", () => {
  const out = toCandidate({ ...baseRaw, event_type: undefined }, baseInput);
  assert.equal(out, null);
});

test("toCandidate: empty-string event_type returns null", () => {
  const out = toCandidate({ ...baseRaw, event_type: "" }, baseInput);
  assert.equal(out, null);
});

test("toCandidate: unknown event_type returns null", () => {
  const out = toCandidate({ ...baseRaw, event_type: "rebranding" }, baseInput);
  assert.equal(out, null);
});

test("toCandidate: confidence below 0.2 returns null", () => {
  const out = toCandidate({ ...baseRaw, confidence: 0.1 }, baseInput);
  assert.equal(out, null);
});

test("toCandidate: missing company_name returns null", () => {
  const out = toCandidate({ ...baseRaw, company_name: "" }, baseInput);
  assert.equal(out, null);
});

test("toCandidate: acquisition event_type is preserved (not coerced)", () => {
  const out = toCandidate({ ...baseRaw, event_type: "acquisition" }, baseInput);
  assert.ok(out);
  assert.equal(out.event_type, "acquisition");
});
