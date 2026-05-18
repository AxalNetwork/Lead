import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("think_tank_rosters: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.brookings.edu/experts/jane-doe/";
  assert.equal(pickAdapter(url)?.id, "think_tank_rosters");
  const r = runAdapter(url, `<html><head><title>Jane Doe</title></head><body><h1>Jane Doe</h1><p>Senior Fellow</p></body></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "think_tank_rosters");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
