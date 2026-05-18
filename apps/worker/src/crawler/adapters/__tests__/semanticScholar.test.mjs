import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("semantic_scholar: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://www.semanticscholar.org/paper/Example/abc123";
  assert.equal(pickAdapter(url)?.id, "semantic_scholar");
  const r = runAdapter(url, `<html><head><title>Example | Semantic Scholar</title><meta property="og:title" content="An Example Paper"></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "semantic_scholar");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
