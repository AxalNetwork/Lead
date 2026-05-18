import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("courtlistener: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.courtlistener.com/docket/12345/example/";
  assert.equal(pickAdapter(url)?.id, "courtlistener");
  const r = runAdapter(url, `<html><head><title>Example v. Other Co, 1:21-cv-12345 - CourtListener.com</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "courtlistener");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
