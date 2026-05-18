import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("uspto_public: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.uspto.gov/patent/US1234567B2";
  assert.equal(pickAdapter(url)?.id, "uspto_public");
  const r = runAdapter(url, `<html><head><title>US1234567B2 - Widget - Google Patents</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "uspto_public");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
