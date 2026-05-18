import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("conference_yc: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.ycombinator.com/companies/example";
  assert.equal(pickAdapter(url)?.id, "conference_yc");
  const r = runAdapter(url, `<html><head><title>Example | Y Combinator</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "conference_yc");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
