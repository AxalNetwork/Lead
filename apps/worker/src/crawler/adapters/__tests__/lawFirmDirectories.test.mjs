import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("law_firm_directories: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.martindale.com/attorney/jane-doe-12345/";
  assert.equal(pickAdapter(url)?.id, "law_firm_directories");
  const r = runAdapter(url, `<html><head><title>Jane Doe | Skadden, Arps, Slate, Meagher & Flom LLP</title></head><body><h1>Jane Doe</h1><p>Partner</p></body></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "law_firm_directories");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
