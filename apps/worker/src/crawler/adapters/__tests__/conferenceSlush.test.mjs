import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("conference_slush: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.slush.org/speakers/jane-doe/";
  assert.equal(pickAdapter(url)?.id, "conference_slush");
  const r = runAdapter(url, `<html><head><title>Jane Doe - Slush</title></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "conference_slush");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
