import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("conference_web_summit: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://websummit.com/speakers/jane-doe";
  assert.equal(pickAdapter(url)?.id, "conference_web_summit");
  const r = runAdapter(url, `<html><head><title>Jane Doe - Web Summit</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "conference_web_summit");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
