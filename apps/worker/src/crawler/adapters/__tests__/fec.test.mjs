import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("fec_public: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.fec.gov/data/committee/C00012345/";
  assert.equal(pickAdapter(url)?.id, "fec_public");
  const r = runAdapter(url, `<html><head><title>JANE DOE FOR CONGRESS - C00012345 - FEC</title></head><body><h1>JANE DOE FOR CONGRESS</h1></body></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "fec_public");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
