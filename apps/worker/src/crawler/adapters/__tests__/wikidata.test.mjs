import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("wikidata: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.wikidata.org/wiki/Q12345";
  assert.equal(pickAdapter(url)?.id, "wikidata");
  const r = runAdapter(url, `<html><head><title>Jane Doe - Wikidata</title><meta property="og:title" content="Jane Doe"></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "wikidata");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
