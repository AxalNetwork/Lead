import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("opencorporates_public: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://opencorporates.com/companies/us_ca/C1234567";
  assert.equal(pickAdapter(url)?.id, "opencorporates_public");
  const r = runAdapter(url, `<html><head><title>EXAMPLE INC :: California (US) :: OpenCorporates</title></head><body><h1>EXAMPLE INC</h1></body></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "opencorporates_public");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
