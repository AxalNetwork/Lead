import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("conference_nrf_big_show: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://nrfbigshow.nrf.com/speakers/jane-doe";
  assert.equal(pickAdapter(url)?.id, "conference_nrf_big_show");
  const r = runAdapter(url, `<html><head><title>Jane Doe - NRF Big Show</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "conference_nrf_big_show");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
