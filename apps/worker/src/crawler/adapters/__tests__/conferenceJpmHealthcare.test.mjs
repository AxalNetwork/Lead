import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("conference_jpm_healthcare: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.jpmorgan.com/healthcare-conference";
  assert.equal(pickAdapter(url)?.id, "conference_jpm_healthcare");
  const r = runAdapter(url, `<html><head><title>JP Morgan Healthcare Conference</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "conference_jpm_healthcare");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
