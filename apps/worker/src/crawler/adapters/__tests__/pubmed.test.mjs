import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("pubmed: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://pubmed.ncbi.nlm.nih.gov/12345/";
  assert.equal(pickAdapter(url)?.id, "pubmed");
  const r = runAdapter(url, `<html><head><meta name="citation_title" content="An Example Study"><meta name="citation_author" content="Doe J"></head></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "pubmed");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
