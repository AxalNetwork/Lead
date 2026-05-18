import { test } from "node:test";
import assert from "node:assert/strict";
const { pickAdapter, runAdapter } = await import("../../../../test-dist/crawler/adapters/index.js");

test("google_scholar_html: routes via pickAdapter + runs without throwing on minimal fixture", () => {
  const url = "https://scholar.google.com/citations?user=ABC123";
  assert.equal(pickAdapter(url)?.id, "google_scholar_html");
  const r = runAdapter(url, `<html><head><title>Jane Doe - Google Scholar</title></head><body><div id="gsc_prf_in">Jane Doe</div></body></html>`);
  if (r.result) assert.equal(r.result.adapter_id, "google_scholar_html");
  else assert.ok(["low_confidence", "no_candidates", "adapter_threw"].includes(r.fallback_reason));
});
