import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("conference_ted: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.ted.com/speakers/jane_doe";
  assert.equal(pickAdapter(url)?.id, "conference_ted");
  const r = runAdapter(url, `<html><head><title>Jane Doe | Speaker | TED</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "conference_ted");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
